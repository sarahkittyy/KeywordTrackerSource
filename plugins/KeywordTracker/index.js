module.exports = (Plugin, Library) => {
  const switchCss = require('switch.css');
  const defaultSettings = {
    whitelistedUsers: [],
    keywords: [],
    ignoredUsers: [],
    guilds: {},
    enabled: true,
    notifications: true,
  };
  const {
    DiscordAPI,
    DOMTools,
    Patcher,
    Logger,
    Settings,
    Utilities,
    PluginUtilities,
    Modals,
    Toasts: Toast,
    DiscordModules: Modules,
  } = Library;

  const RegexEscape = function(string) {
    return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')
  };

  return class KeywordTracker extends Plugin {
    async onStart() {
      this.loadSettings();
      PluginUtilities.addStyle(this.getName(), switchCss);

      let dispatchModule = BdApi.findModuleByProps('dispatch');
      this.cancelPatch = BdApi.monkeyPatch(dispatchModule, 'dispatch', { after: this.handleMessage.bind(this) });

      this.userId = BdApi.findModuleByProps('getId').getId();
    }

    onStop() {
      this.saveSettings();

      Patcher.unpatchAll(this.getName());
      this.cancelPatch();
      PluginUtilities.removeStyle(this.getName());
    }

    handleMessage(data) {
      try {
        const { guilds } = DiscordAPI;
        const { methodArguments: args } = data;
        let event = args[0];
        if (event.type !== 'MESSAGE_CREATE') return;
        // get message data
        let { message } = event;
        // get channel data
        let channel = Modules.ChannelStore.getChannel(message.channel_id);
        // assert message data is right
        if (!message.author) {
          message = Modules.MessageStore.getMessage(channel.id, message.id);
          if (!message || !message.author) return;
        }
        if (message.author.id === this.userId) return;
        // ignore ignored users
        if (this.settings.ignoredUsers.includes(message.author.id)) return;
        if (!message.content) return;

        // no dms!
        if (!channel.guild_id) return;

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
          let isSlashRegex = /^\/(.*)\/([a-z]*)$/g.exec(kw);
          if (isSlashRegex != null) {
            let text = isSlashRegex[1];
            let flags = isSlashRegex[2];
            rx = new RegExp(text, flags);
          } else {
            rx = new RegExp(RegexEscape(kw));
          }

          if (rx.test(message.content)) {
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

    sendMatchNotification(thumbnail, title, text, redirect) {
      Modules.NotificationModule.showNotification(
        thumbnail,
        title,
        text,
        // opts
        {
          onClick: () => {
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
      Logger.info('Match found!');
      this.sendMatchNotification(
        `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.webp?size=256`,
        `User match in ${guild}!`,
        `${message.author.username} typed in #${channel.name}.`,
        `/channels/${message.guild_id}/${channel.id}/${message.id}`
      );
      if (this.settings.notifications) {
        Modules.SoundModule.playSound("message1", 0.4);
      }
    }

    pingSuccess(message, channel, guild, match) {
      Logger.info('Match found!');
      this.sendMatchNotification(
        `https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.webp?size=256`,
        `Keyword match in ${guild}!`,
        `${message.author.username} matched ${match} in #${channel.name}.`,
        `/channels/${message.guild_id}/${channel.id}/${message.id}`
      );
      if (this.settings.notifications) {
        Modules.SoundModule.playSound("message1", 0.4);
      }
      //Toast.info(`Message by ${message.author.username} in #${channel.name} matches ${match}`);
    }

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

    getSettingsPanel() {
      return this.buildSettings().getElement();
    }

    saveSettings() {
      // clear out empty keywords :)
      this.settings.keywords = this.settings.keywords.filter((v) => v.trim().length > 0);
      PluginUtilities.saveSettings('KeywordTracker', this.settings);
    }

    loadSettings() {
      // load settings
      this.settings = Utilities.deepclone(PluginUtilities.loadSettings('KeywordTracker', defaultSettings));
    }

    //TODO: god why
    buildSettings() {
      const { Textbox, SettingPanel, SettingGroup, Keybind, SettingField, /*Switch*/ } = Settings;
      const { sortedGuilds, guilds: normGuilds } = DiscordAPI;
      const { parseHTML } = DOMTools;

      // sorted guilds doesn't have critical data, and the normal guild list isn't sorted.
      const guilds = sortedGuilds.reduce((arr, gobj) => {
        return arr.concat(gobj.discordObject.guilds.map(g => {
          return normGuilds.find(v => v.id === g.id);
        }));
      }, []);
      // when the main guild switch is hit this event is fired, causing all channel switches to sync
      const GuildFlushEvent = new Event('guildflushevent');

      let panel = new SettingPanel();
      // !! KEYWORDS
      let keywords = new SettingGroup('Keywords');
      panel.append(keywords);

      let tip = new SettingField('', 'One keyword per line. Regex syntax allowed, eg. /sarah/i.', null, document.createElement('div'));
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
              .filter(c => c.type === 'GUILD_TEXT')
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
            .filter(c => c.type === 'GUILD_TEXT')
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
      let notificationToggle = new SettingField('', 'Enable notification sounds', null, notificationSwitch, { noteOnTop: true });
      other.append(notificationToggle);

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
