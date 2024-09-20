module.exports = (Plugin, Library) => {
	const switchCss = require('switch.css');
	const inboxCss = require('inbox.css');
	const iconSVG = require('book-icon.svg');
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
		markJumpedRead: false,
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
		React,
	} = BdApi;

	const NotificationModule = Webpack.getByKeys("showNotification");
	const ModalActions = Webpack.getByKeys("openModal", "updateModal");
	const ButtonData = Webpack.getByKeys("ButtonColors");
	const GuildStore = Webpack.getStore("GuildStore");

	const RegexEscape = function(string) {
		return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
	};

	const log = (...args) => {
		Logger.info(...args);
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

			let dispatchModule = Webpack.getByKeys('dispatch', 'subscribe');
			Patcher.after(this.getName(), dispatchModule, 'dispatch', this.handleMessage.bind(this));

			const stringFilter = BdApi.Webpack.Filters.byStrings(".GUILD_HOME");
			const keyFilter = BdApi.Webpack.Filters.byKeys("Icon", "Title");

			// patch the title bar to add the inbox button
			const [ titlebarModule, titlebarKey ] = Webpack.getWithKey((m) => keyFilter(m) && !stringFilter(m));
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

		// fired when a message is received
		handleMessage(_, args) {
			try {
				const guilds = Object.values(GuildStore.getGuilds());
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
				// i don't know what optimistic means exactly but it only happens on self messages and this line fixes double pings in testing
				if (event.optimistic === true) return;

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
				this.settings.keywords.every((keyword) => {
					let regex = undefined; // the regex to run on the message content
					let filter = undefined; 
					// retrieve the filter (user, channel, server) if there is any
					//								 type		 id		 regex
					let isFiltered = /^([@#]?)(\d+):(.*)$/g.exec(keyword);
					if (isFiltered != null) {
						filter = {
							type: isFiltered[1],
							id: isFiltered[2],
						};
						keyword = isFiltered[3];
					}
					// then convert the rest into a regex
					let isSlashRegex = /^\/(.*)\/([a-z]*)$/g.exec(keyword);
					if (isSlashRegex != null) {
						let text = isSlashRegex[1];
						let flags = isSlashRegex[2];
						regex = new RegExp(text, flags);
					} else {
						regex = new RegExp(RegexEscape(keyword));
					}

					// if there is a filter,,, and it doesn't pass, keep searching
					if (filter != undefined && !this.passesFilter(filter, message)) {
						return true;
					}

					if (regex.test(message.content) || (
						message.embeds &&
						this.settings.allowEmbeds &&
						regex.test(JSON.stringify(this.objectValues(message.embeds)))
					)) {
						let guild = guilds.find(g => g.id === channel.guild_id);
						this.pingSuccess(message, channel, guild.name, regex);
						return false; // stop searching
					}
					return true;
				});
			} catch (e) {
				Logger.error(`${e}`);
			}
		}

		// type = @userid, #channelid, or serverid, message object, true if the message passes the filter and the content should be matched.
		passesFilter({ type, id }, message) {
			switch (type) {
				case '@':
					return message.author.id === id;
				case '#':
					return message.channel_id === id;
				case '':
					return message.guild_id === id;
				default:
					return false;
			}
		}

		sendMatchNotification(thumbnail, title, text, redirect, message) {
			NotificationModule.showNotification(
				thumbnail,
				title,
				text,
				{
				},
				// opts
				{
					sound: this.settings.notifications ? 'message1' : null,
					onClick: () => {
						if (this.settings.markJumpedRead) {
							delete this.settings.unreadMatches[message.id];
						}
						this.saveSettings();
						console.log(Modules.NavigationUtils.transitionTo);
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
			log('Whitelist match found!');
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
			log('Match found!');
			this.sendMatchNotification(
				`https://cdn.discordapp.com/avatars/${message.author.id}/${message.author.avatar}.webp?size=256`,
				`Keyword match in ${guild}!`,
				`${message.author.username} matched ${match} in #${channel.name}.`,
				`/channels/${message.guild_id}/${channel.id}/${message.id}`,
				message,
			);
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

		// from ui_modals.js in bd plugin lib, rewriting to fix since broken as of 4/2/2024
		showModal(title, children, options = {}) {
			const {danger = false, confirmText = "Okay", cancelText = "Cancel", onConfirm = () => {}, onCancel = () => {}} = options;
			return ModalActions.openModal(props => {
					return React.createElement(Modules.ConfirmationModal, Object.assign({
							header: title,
							confirmButtonColor: danger ? ButtonData.ButtonColors.RED : ButtonData.ButtonColors.BRAND,
							confirmText: confirmText,
							cancelText: cancelText,
							onConfirm: onConfirm,
							onCancel: onCancel
					}, props), children);
			});
		}

		// build the inbox panel placed directly after the pinned messages button
		buildInboxPanel() {
			let pinned = document.querySelector('div[class^="toolbar" i] > div:first-child');
			if (!pinned) {
				return;
			}

			const ModalCloseEvent = new Event('modalclose');

			let inbox = pinned.cloneNode(true);
			inbox.querySelector('span')?.remove();
			inbox.setAttribute('is-keyword-tracker-inbox', true);
			inbox.setAttribute('aria-label', 'Keyword Matches');
			let icon = inbox.querySelector('svg');
			icon.setAttribute('viewBox', '0 0 122 96');
			// icon!
			icon.innerHTML = iconSVG;
			inbox.appendChild(icon);

			// add hover tooltip
			let tooltip = new Tooltip(inbox, 'Keyword Matches');

			// actual modal window on-click
			const openModal = () => {
				var modalKey = undefined;
				const closeModal = () => {
					Modules.ModalActions.closeModal(modalKey);
				};
				modalKey = this.showModal('Keyword Matches', this.renderInbox(closeModal), {
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
					const entry = document.createElement('div');
					entry.className = 'kt-inbox-entry';
					entry.innerHTML = `
						<div class="kt-entry-row">
							<img class="kt-usericon" src="https://cdn.discordapp.com/avatars/${msg.author.id}/${msg.author.avatar}.webp?size=24" />
							<span class="kt-username"></span>
							<span class="kt-timestamp">${new Date(msg.timestamp).toLocaleString()}</span>
						</div>
						<div class="kt-content"></div>
						<div class="kt-entry-row">
							<span class="kt-matched">Matched <code></code></span>
							<span class="kt-spacer"></span>
							<div class="kt-button kt-read">
								<svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M21.7 5.3a1 1 0 0 1 0 1.4l-12 12a1 1 0 0 1-1.4 0l-6-6a1 1 0 1 1 1.4-1.4L9 16.58l11.3-11.3a1 1 0 0 1 1.4 0Z"></path></svg>
							</div>
							<div class="kt-button kt-jump">
								<svg width="16" height="16" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M15 2a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 1 1-2 0V4.41l-4.3 4.3a1 1 0 1 1-1.4-1.42L19.58 3H16a1 1 0 0 1-1-1Z" class=""></path><path fill="currentColor" d="M5 2a3 3 0 0 0-3 3v14a3 3 0 0 0 3 3h14a3 3 0 0 0 3-3v-6a1 1 0 1 0-2 0v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h6a1 1 0 1 0 0-2H5Z"></path></svg>
							</div>
						</div>
					`;

					entry.querySelector('.kt-username').textContent = msg.author.username;
					entry.querySelector('.kt-content').textContent = msg.content;
					entry.querySelector('.kt-matched > code').textContent = msg._match;

					let read_btn = entry.querySelector('.kt-read');
					new Tooltip(read_btn, 'Mark as read');
					read_btn.addEventListener('click', e => {
						delete this.settings.unreadMatches[msg.id];
						this.saveSettings();
						root.dispatchEvent(EntryFlushEvent);
					});

					let jump_btn = entry.querySelector('.kt-jump');
					new Tooltip(jump_btn, 'Jump to message');
					jump_btn.addEventListener('click', e => {
						if (this.settings.markJumpedRead) {
							delete this.settings.unreadMatches[msg.id];
						}
						this.saveSettings();
						closeModal();
						Modules.NavigationUtils.transitionTo(
							`/channels/${msg.guild_id}/${msg.channel_id}/${msg.id}`,
							undefined,
							undefined,
						);
					});

					return entry;
				};
				if (sortedMatches.length === 0) {
					root.textContent = 'No recent matches.';
					root.setAttribute('style', 'line-height: 90px; text-align: center;	color: var(--text-normal);');
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
			const guilds = Object.values(GuildStore.getGuilds())
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

			let tip = new SettingField('', 'One case-sensitive keyword per line. Regex syntax allowed, eg. /sarah/i. You can filter to specific users, channels, or servers. Examples:', null, document.createElement('div'));
			keywords.append(tip);
			let tip2 = new SettingField('', '@12345678:Keyword watches for "Keyword" from user id 12345678 (Right click user -> Copy User ID, requires developer mode)', null, document.createElement('div'));
			keywords.append(tip2);
			let tip3 = new SettingField('', '#442312345:/case-insensitive/i watches messages in channel id 442312345 (Right click channel -> Copy Channel ID, requires developer mode)', null, document.createElement('div'));
			keywords.append(tip3);
			let tip4 = new SettingField('', '1239871234:/\d+/i watches numbers from server id 1239871234 (Right click server -> Copy Server ID, requires developer mode)', null, document.createElement('div'));
			keywords.append(tip4);
			
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
							channelSwitchContainer.className = 'kt-channel-container';
							let channelSwitchText = document.createElement('h2');
							channelSwitchText.className = 'kt-channel-name';
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

			let markJumpedReadSwitch = this.makeSwitch(this.settings.markJumpedRead, (v) => {
				this.settings.markJumpedRead = v;
				this.saveSettings();
			});

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

			let markJumpedReadToggle = new SettingField('', 'Mark messages as read when jumping to them.', null, markJumpedReadSwitch, { noteOnTop: true });
			other.append(markJumpedReadToggle);

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
