module.exports = (Plugin, Library) => {
  const switchCss = require('switch.css');
  const inboxCss = require('inbox.css');
	const iconSVG = require('icon.svg');
  const defaultSettings = {
    whitelistedUsers: [],
    keywords: [],
    ignoredUsers: [],
    guilds: {},
    enabled: true,
    unreadMatches: {},
    notifications: true,
    allowSelf: false,
		allowEmbeds: true,
		allowBots: true,
  };
  const {
		ReactTools,
    Logger,
    Settings,
    Utilities,
    PluginUtilities,
    Modals,
    Tooltip,
    Toasts: Toast,
    DiscordModules: Modules,
  } = Library;
	const {
		Patcher,
		Webpack,
		DOM,
		ReactUtils,
	} = BdApi;

  const RegexEscape = function(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  };

  return class KeywordTracker extends Plugin {
		/**
		 * Plugin init
		 *
		 * @async
		 */
    async onStart() {
      PluginUtilities.addStyle(this.getName(), switchCss);
      PluginUtilities.addStyle(this.getName(), inboxCss);
      this.loadSettings();
      this.inboxPanel = null;

      let dispatchModule = BdApi.findModuleByProps('dispatch', 'subscribe');
      Patcher.after(this.getName(), dispatchModule, 'dispatch', this.handleMessage.bind(this));

			const stringFilter = BdApi.Webpack.Filters.byStrings(".GUILD_HOME");
			const keyFilter = BdApi.Webpack.Filters.byKeys("Icon", "Title");

			// patch the title bar to add the inbox button
			const [ titlebarModule, titlebarKey ] =BdApi.Webpack.getWithKey((m) => keyFilter(m) && !stringFilter(m));
			Patcher.before(this.getName(), titlebarModule, titlebarKey, (that, [ props ]) => {
        if (props.toolbar.type === 'function') return;
        if (this.inboxPanel == null) { // build the panel if it's not already built
          this.inboxPanel = this.buildInboxPanel();
        }
				if (typeof props.toolbar.props.children[0].splice !== 'function') return; // make sure the splice function exists :p
				let idx = Math.max(3, props.toolbar.props.children[0].length - 1);
				// insert the panel
				props.toolbar.props.children[0].splice(idx, 0, this.inboxPanel);
			});

      this.userId = Modules.UserStore.getCurrentUser().id;
    }

    onStop() {
      this.saveSettings();

      Patcher.unpatchAll(this.getName());
      PluginUtilities.removeStyle(this.getName());
    }

		objectValues(object) {
			if (!object) return [];
			const res = [];
			for(const [k, v] of Object.entries(object)) {
				if (typeof v === 'object') {
					res.push(...this.objectValues(v));
				} else {
					res.push(v);
				}
			}
			return res;
		}

    handleMessage(_, args) {
      try {
        const guilds = Object.values(Modules.GuildStore.getGuilds());
        let event = args[0];
        if (event.type !== 'MESSAGE_CREATE') return;
        // get me  data
        let { message } = event;
        // get channel data
        let channel = Modules.ChannelStore.getChannel(message.channel_id);
        // assert message data is right
        if (!message.author) {
          message = Modules.MessageStore.getMessage(channel.id, message.id);
          if (!message || !message.author) return;
        }
        if (this.settings.allowSelf === false && message.author.id === this.userId) return;
        // ignore ignored users
        if (this.settings.ignoredUsers.includes(message.author.id)) return;

        if (!message.content && (!message.embeds || message.embeds.length === 0)) return;
				if (message.author.bot && !this.settings.allowBots) return;

        // no dms!
        if (!channel.guild_id) return;
				if (!message.guild_id) message.guild_id = channel.guild_id;

        // add guild to settings if it does not exist
        if (this.settings.guilds[channel.guild_id] == null) {
          let g = guilds.find(g => g.id === channel.guild_id);
          if (!g) return;
          this.settings.guilds[g.id] = {
            // set all channels to enabled by default
            channels: g.channels
              .filter(c => c.type === 'GUILD_TEXT')
              .reduce((obj, c) => {
                obj[c.id] = true;
                return obj;
              }, {}),
            enabled: true,
          };
          this.saveSettings();
        }

        // ensure that the channel this is from is enabled
        if (!this.settings.guilds[channel.guild_id].channels[channel.id]) return;

        let whitelistedUserFound = !this.settings.whitelistedUsers.every((userId) => {
          if (message.author.id === userId) {
            const guild = guilds.find(g => g.id === channel.guild_id);
            this.pingWhitelistMatch(message, channel, guild.name);
            return false; // stop searching
          }
          return true;
        });

        // do not bother scanning keywords if the user themself was matched
        if (whitelistedUserFound) {
          return;
        }

        // run through every single keyword as a regex
        this.settings.keywords.every((kw) => {
          let rx;
					let uid;
					// first, filter out any user id matching
					let isUserSpecific = /^@(\d+):(.*)$/g.exec(kw);
					if (isUserSpecific != null) {
						uid = isUserSpecific[1];
						kw = isUserSpecific[2];
					}
					// then convert the rest into a regex
          let isSlashRegex = /^\/(.*)\/([a-z]*)$/g.exec(kw);
          if (isSlashRegex != null) {
            let text = isSlashRegex[1];
            let flags = isSlashRegex[2];
            rx = new RegExp(text, flags);
          } else {
            rx = new RegExp(RegexEscape(kw));
          }

					if (uid != null && !isNaN(uid) && message.author.id !== uid) {
						return true;
					}

          if (rx.test(message.content) || (
						message.embeds &&
						this.settings.allowEmbeds &&
						rx.test(JSON.stringify(this.objectValues(message.embeds)))
					)) {
            let guild = guilds.find(g => g.id === channel.guild_id);
            this.pingSuccess(message, channel, guild.name, rx);
            return false; // stop searching
          }
          return true;
        });
      } catch (e) {
        Logger.error(`${e}`);
      }
    }

    sendMatchNotification(thumbnail, title, text, redirect, message) {
      Modules.NotificationModule.showNotification(
        thumbnail,
        title,
        text,
        {
        },
				// opts
				{
					sound: this.settings.notifications ? 'message1' : null,
          onClick: () => {
            delete this.settings.unreadMatches[message.id];
            this.saveSettings();
            Modules.NavigationUtils.transitionTo(
              redirect,
              undefined,
              undefined,
            );
          }
				}
      );
    }

    pingWhitelistMatch(message, channel, guild) {
      Logger.info('Whitelist match found!');
      this.sendMatchNotification(
        `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.webp?size=256`,
        `User match in ${guild}!`,
        `${message.author.username} typed in #${channel.name}.`,
        `/channels/${message.guild_id}/${channel.id}/${message.id}`,
        message,
      );
      message._match = `User ID ${message.author.id}`;
      this.settings.unreadMatches[message.id] = message;
      this.saveSettings();
    }

    pingSuccess(message, channel, guild, match) {
      Logger.info('Match found!');
      this.sendMatchNotification(
        `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.webp?size=256`,
        `Keyword match in ${guild}!`,
        `${message.author.username} matched ${match} in #${channel.name}.`,
        `/channels/${message.guild_id}/${channel.id}/${message.id}`,
        message,
      );
      //if (this.settings.notifications) {
        //Modules.SoundModule.playSound("message1", 0.4);
      //}
      message._match = `${match}`;
      this.settings.unreadMatches[message.id] = message;
      this.saveSettings();
    }

		/**
		 * A single on/off switch
		 *
		 * @param {bool} iv - the initial state of the switch
		 * @param {function} callback - the function to run when the switch is flipped
		 * @returns {html} html element
		 */
    makeSwitch(iv, callback) {
      let label = document.createElement('label');
      label.className = 'switch';
      let input = document.createElement('input');
      input.setAttribute('type', 'checkbox');
      input.checked = iv;
      let div = document.createElement('div');
      label.append(input);
      label.append(div);
      input.addEventListener('input', function (e) { 
        callback(this.checked);
      });
      return label;
    }

		/**
		 * For Zere's to render the settings panel.
		 *
		 */
    getSettingsPanel() {
      return this.buildSettings().getElement();
    }

		/**
		 * Saves settings to file.
		 *
		 */
    saveSettings() {
      // clears out empty keywords before saving :)
      this.settings.keywords = this.settings.keywords.filter((v) => v.trim().length > 0);
      PluginUtilities.saveSettings('KeywordTracker', this.settings);
    }

		/**
		 * Loads settings from storage.
		 *
		 */
    loadSettings() {
      // load settings
      this.settings = Utilities.deepclone(PluginUtilities.loadSettings('KeywordTracker', defaultSettings));
    }

    // build the inbox panel placed directly after the pinned messages button
    buildInboxPanel() {
      let pinned = document.querySelector('div[class*="toolbar" i] > div:first-child');
      if (!pinned) {
        return;
      }

      const ModalCloseEvent = new Event('modalclose');

      let inbox = pinned.cloneNode(true);
      inbox.setAttribute('is-keyword-tracker-inbox', true);
      inbox.setAttribute('aria-label', 'Keyword Matches');
      let icon = inbox.querySelector('svg');
      icon.setAttribute('viewBox', '0 0 20 20');
      // icon!
      icon.innerHTML = iconSVG;
      inbox.appendChild(icon);

      // add hover tooltip
      let tooltip = new Tooltip(inbox, 'Keyword Matches');

      // actual modal window on-click
      const openModal = () => {
        let modalKey = Modals.showModal('Keyword Matches', this.renderInbox(() => { Modules.ModalActions.closeModal(modalKey); }), {
          confirmText: 'Close',
          cancelText: 'Mark as Read',
          onCancel: () => {
            this.settings.unreadMatches = {};
            this.saveSettings();
          },
          onConfirm: () => {
            this.saveSettings();
          }
        });
        const closeModal = () => {
          Modules.ModalActions.closeModal(modalKey);
        };
        inbox.removeEventListener('modalclose', closeModal);
        inbox.addEventListener('modalclose', closeModal);
      };
      inbox.removeEventListener('click', openModal);
      inbox.addEventListener('click', openModal);

      return ReactTools.createWrappedElement(inbox);
    }

    // render all messages from settings.unreadMatches
    renderInbox(closeModal) {
      let root = document.createElement('div');
      root.className = 'kt-inbox-container';

      const EntryFlushEvent = new Event('entryflush');

      const setupEntries = () => {
        let sortedMatches = Object.values(this.settings.unreadMatches)
          .sort((a, b) => {
            return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
          })
          .filter(msg => { // filter messages older than 60 days
            let timeDiff = Math.abs(new Date(msg.timestamp).getTime() - new Date().getTime());
            let daysDiff = Math.ceil(timeDiff / (1000 * 3600 * 24));
            return daysDiff <= 60;
          });

        const matchEntry = (msg) => {
          let entry = document.createElement('div');
          entry.className = 'kt-inbox-entry';

          let timestamp = document.createElement('span');
          timestamp.className = 'timestamp';
          timestamp.textContent = `${new Date(msg.timestamp).toLocaleString()}`;
          entry.appendChild(timestamp);

          let icon = document.createElement('img');
          let iconUrl = `https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.webp?size=256`
          icon.className = 'usericon';
          icon.setAttribute('src', iconUrl);
          entry.appendChild(icon);

          let username = document.createElement('span');
          username.className = 'username';
          username.textContent = `${msg.author.username}: `;
          entry.appendChild(username);
          
          let content = document.createElement('span');
          content.className = 'content';
          content.textContent = msg.content;
          entry.appendChild(content);

          entry.appendChild(document.createElement('br'));

          let matched = document.createElement('span');
          matched.className = 'matched';
          matched.textContent = `Matched ${msg._match}`;
          entry.appendChild(matched);

          let markRead = document.createElement('button');
          markRead.addEventListener('click', () => {
            delete this.settings.unreadMatches[msg.id];
            this.saveSettings();
            root.dispatchEvent(EntryFlushEvent);
          });
          markRead.textContent = 'Mark as Read';
          entry.appendChild(markRead);

          let jump = document.createElement('button');
          jump.addEventListener('click', () => {
            delete this.settings.unreadMatches[msg.id];
            this.saveSettings();
            closeModal();
            Modules.NavigationUtils.transitionTo(
              `/channels/${msg.guild_id}/${msg.channel_id}/${msg.id}`,
              undefined,
              undefined,
            );
          });
          jump.textContent = 'Jump';
          entry.appendChild(jump);

          return entry;
        };
        if (sortedMatches.length === 0) {
          root.textContent = 'No recent matches.';
          root.setAttribute('style', 'line-height: 90px; text-align: center;');
        } else {
          for(let msg of sortedMatches) {
            root.appendChild(matchEntry(msg));
          }
        }
      };
      setupEntries();

      root.addEventListener('entryflush', () => {
        root.textContent = '';
        setupEntries();
      });

      return ReactTools.createWrappedElement(root);
    }

    //TODO: god why
    buildSettings() {
      const { Textbox, SettingPanel, SettingGroup, Keybind, SettingField, /*Switch*/ } = Settings;
      const guilds = Object.values(Modules.GuildStore.getGuilds())
											.sort((a, b) => `${a.id}`.localeCompare(`${b.id}`))
                      .map(g => {
                        g.channels = Modules.GuildChannelsStore.getChannels(g.id).SELECTABLE.map(c => c.channel);
                        return g;
                      });
      const { parseHTML } = DOM;

      // when the main guild switch is hit this event is fired, causing all channel switches to sync
      const GuildFlushEvent = new Event('guildflushevent');

      let panel = new SettingPanel();
      // !! KEYWORDS
      let keywords = new SettingGroup('Keywords');
      panel.append(keywords);

      let tip = new SettingField('', 'One keyword per line. Regex syntax allowed, eg. /sarah/i.\nPrefix your keyword with @userid: to track keyword matches from a single user, i.e. @135895345296048128:/word/i. A user\'s id can be found by right clicking their name -> Copy ID (Requires developer mode to be on.)', null, document.createElement('div'));
      keywords.append(tip);
      
      // add keyword textbox
      let textbox = document.createElement('textarea');
      textbox.value = this.settings.keywords.join('\n');
      textbox.addEventListener('change', () => {
        this.settings.keywords = textbox.value.split('\n');
        this.saveSettings();
      });
      textbox.setAttribute('rows', '8');
      textbox.style.width = '95%';
      textbox.style.resize = 'none';
      textbox.style['margin-left'] = '2.5%';
      textbox.style.borderRadius = '3px';
      textbox.style.border = '2px solid grey';
      textbox.style.backgroundColor = '#ddd';
      keywords.append(textbox);

      // !! CHANNELS
      let channels = new SettingGroup('Channels');
      panel.append(channels);

      if (this.settings.enabled == null) {
        this.settings.enabled = true;
      }

      let masstoggleSwitch = this.makeSwitch(this.settings.enabled, (v) => {
        this.enabled = v;
        for (let gid in this.settings.guilds) {
          this.settings.guilds[gid].enabled = v;
          for (let cid in this.settings.guilds[gid].channels) {
            this.settings.guilds[gid].channels[cid] = v;
          }
        }
        // refresh
        groups.forEach(g => g());
        this.saveSettings();
      });

      let masstoggle = new SettingField('', 'Toggle every single guild and channel on / off (careful!)', null, masstoggleSwitch, { noteOnTop: true });
      channels.append(masstoggle);
      // for every guild...
      var groups = [];
      guilds.forEach(g => {
        // create the group, and thumbnail
        let guildGroup = new SettingGroup(g.name);
        guildGroup.getElement().style['min-height'] = '34px';
        groups.push(() => guildGroup.getElement().dispatchEvent(GuildFlushEvent));
        if (g.icon != null) {
          let thumbnail = parseHTML(
            `<img src="https://cdn.discordapp.com/icons/${g.id}/${g.icon}.webp?size=256}" />`
          );
          thumbnail.style.width = '32px';
          thumbnail.style.height = '32px';
          thumbnail.style.float = 'left';
          thumbnail.setAttribute('align', 'left');
          channels.append(thumbnail);
        } else {
          guildGroup.getElement().style['padding-left'] = '16px';
        }

        // add group to settings if it does not exist
        if (this.settings.guilds[g.id] == null) {
          this.settings.guilds[g.id] = {
            // set all channels to enabled by default
            channels: g.channels
              .reduce((obj, c) => {
                obj[c.id] = true;
                return obj;
              }, {}),
            enabled: true,
          };
        }
        // add switch next to guild to toggle all channels
        if (this.settings.guilds[g.id].enabled == null) {
          this.settings.guilds[g.id].enabled = true;
        }
        var guildSwitch = this.makeSwitch(this.settings.guilds[g.id].enabled, (v) => {
          this.settings.guilds[g.id].enabled = v;
          for(let cid in this.settings.guilds[g.id].channels) {
            this.settings.guilds[g.id].channels[cid] = v;
          }
          guildGroup.getElement().dispatchEvent(GuildFlushEvent);
          this.saveSettings();
        });
        guildSwitch.style.marginLeft = '4px';
        if (g.icon == null) {
          guildSwitch.style['margin-left'] = '36px';
        }
        guildGroup.getElement().addEventListener('guildflushevent', () => {
          guildSwitch.firstElementChild.checked = this.settings.guilds[g.id].enabled;
        }, false);

        channels.append(guildSwitch);
        channels.append(guildGroup);

        // load channels on click
        let channelLoader = () => {
          // for every channel...
          g.channels
            .forEach((c, i) => {
              // ...add a switch
              let status = this.settings.guilds[g.id].channels[c.id];
              if (status == null) {
                Logger.warn(`channel ${c.id} of guild ${g.id} doesn't exist. creating it.`);
                this.settings.guilds[g.id].channels[c.id] = true;
              }
              let channelSwitch = this.makeSwitch(status, (v) => {
                this.settings.guilds[g.id].channels[c.id] = v;
                this.saveSettings();
              });
              let channelSwitchContainer = document.createElement('div');
              channelSwitchContainer.style.width = '95%';
              channelSwitchContainer.style['margin-left'] = '2.5%';
              channelSwitchContainer.style.display = 'flex';
              channelSwitchContainer.style['justify-content'] = 'space-between';
              channelSwitchContainer.style['margin-bottom'] = '3px';
              channelSwitchContainer.style['border-bottom'] = '1px solid #333';
              let channelSwitchText = document.createElement('h2');
              channelSwitchText.style['font-size'] = '16px';
              channelSwitchText.style['color'] = 'white';
              channelSwitchText.innerText = `${c.name}`;
              channelSwitchContainer.append(channelSwitchText);
              channelSwitchContainer.append(channelSwitch);
              guildGroup.append(channelSwitchContainer);
              // when the guild switch is hit, toggle all these switches
              guildGroup.getElement().addEventListener('guildflushevent', () => {
                channelSwitch.firstElementChild.checked = this.settings.guilds[g.id].enabled;
              }, false);
            });
          // ignore future attempts to load this data :)
          guildGroup.getElement().removeEventListener('click', channelLoader);
        };
        guildGroup.getElement().addEventListener('click', channelLoader);
      });

      //!! OTHER
      let other = new SettingGroup('Other');
      panel.append(other);

      let notificationSwitch = this.makeSwitch(this.settings.notifications, (v) => {
        this.settings.notifications = v;
        this.saveSettings();
      });

      let selfPingSwitch = this.makeSwitch(this.settings.allowSelf, (v) => {
        this.settings.allowSelf = v;
        this.saveSettings();
      });

      let botSwitch = this.makeSwitch(this.settings.allowBots, (v) => {
        this.settings.allowBots = v;
        this.saveSettings();
      });

      let embedSwitch = this.makeSwitch(this.settings.allowEmbeds, (v) => {
        this.settings.allowEmbeds = v;
        this.saveSettings();
      });

      let notificationToggle = new SettingField('', 'Enable notification sounds', null, notificationSwitch, { noteOnTop: true });
      other.append(notificationToggle);

      let embedToggle = new SettingField('', 'Enable matching embed content.', null, embedSwitch, { noteOnTop: true });
      other.append(embedToggle);

      let botToggle = new SettingField('', 'Enable bots to trigger notifications.', null, botSwitch, { noteOnTop: true });
      other.append(botToggle);

      let selfPingToggle = new SettingField('', 'Enable own messages to trigger notifications.', null, selfPingSwitch, { noteOnTop: true });
      other.append(selfPingToggle);


      let ignoreuseridstip = new SettingField('', 'Ignore users here. One user ID per line. (Right click name -> Copy ID). Be sure developer options are on.', null, document.createElement('div'));
      other.append(ignoreuseridstip);

      // add keyword textbox
      let ignoreuserids = document.createElement('textarea');
      ignoreuserids.value = this.settings.ignoredUsers.join('\n');
      ignoreuserids.addEventListener('change', () => {
        this.settings.ignoredUsers = ignoreuserids.value.split('\n');
        this.saveSettings();
      });
      ignoreuserids.setAttribute('rows', '8');
      ignoreuserids.style.width = '95%';
      ignoreuserids.style.resize = 'none';
      ignoreuserids.style['margin-left'] = '2.5%';
      ignoreuserids.style.borderRadius = '3px';
      ignoreuserids.style.border = '2px solid grey';
      ignoreuserids.style.backgroundColor = '#ddd';
      other.append(ignoreuserids);

      let whitelistuseridstip = new SettingField('', 'Whitelist users here (all their messages will trigger notifications). One user ID per line. (Right click name -> Copy ID). Be sure developer options are on.', null, document.createElement('div'));
      other.append(whitelistuseridstip);

      let whitelistuserids = document.createElement('textarea');
      whitelistuserids.value = this.settings.whitelistedUsers.join('\n');
      whitelistuserids.addEventListener('change', () => {
        this.settings.whitelistedUsers = whitelistuserids.value.split('\n');
        this.saveSettings();
      });
      whitelistuserids.setAttribute('rows', '8');
      whitelistuserids.style.width = '95%';
      whitelistuserids.style.resize = 'none';
      whitelistuserids.style['margin-left'] = '2.5%';
      whitelistuserids.style.borderRadius = '3px';
      whitelistuserids.style.border = '2px solid grey';
      whitelistuserids.style.backgroundColor = '#ddd';
      other.append(whitelistuserids);

      this.saveSettings();
      return panel;
    }
  };
};
