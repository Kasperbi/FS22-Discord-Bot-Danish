#! /usr/bin/env node

const _ = require('lodash');
const merge = require('deepmerge');
const fs = require('fs');
const eur_kurs = '7.46'
const {
  Client, GatewayIntentBits, PermissionsBitField, ChannelType,
} = require('discord.js');
const { onExit } = require('signal-exit');
require('dotenv-flow').config({
  silent: true,
});

const {
  getDefaultDatabase,
  formatMinutes,
  formatPlayers,
  getTimestamp,
  getDataFromAPI,
  parseData,
  getModString,
} = require('../src/utils/utils');
const { getNextPurge, willPurge, purgeOldMessages } = require('../src/utils/purge');

const dbPath = process.env.FS22_BOT_DB_PATH;
const pollIntervalMillis = Math.max(
  parseInt(process.env.FS22_BOT_POLL_INTERVAL_MINUTES, 10) || 1, // integer or 1
  1, // minimum of 1
) * 60000;

let intervalTimer = null;

let db = getDefaultDatabase();

let nextPurge = 0;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

const getUpdateString = (
  newData,
  previousServer,
  previousMods,
  previousPlayers,
  previousCareerSavegame,
) => {
  if (!newData) {
    // server is offline, this shouldn't have been called
    return null;
  }

  let string = '';

  const previousDlcCount = Object.values(previousMods).filter(({ name: modName }) => modName.startsWith('pdlc_')).length;
  const previousModCount = Object.values(previousMods).filter(({ name: modName }) => !modName.startsWith('pdlc_')).length;

  const dlcCount = Object.values(newData.mods).filter(({ name: modName }) => modName.startsWith('pdlc_')).length;
  const modCount = Object.values(newData.mods).filter(({ name: modName }) => !modName.startsWith('pdlc_')).length;

  const {
    game, version, name: serverName, mapName, online,
  } = newData.server;
  // if the online status has changed, and the server is now online
  if (online && !previousServer.online) {
    // send udpated server status
    string += ':tractor: Serveren Er **Igen Online**!\n';
  }

  const dlcString = getModString(newData, previousMods, true);
  const modString = getModString(newData, previousMods, false);

  if ((!!game && game !== previousServer.game)
    || (!!version && version !== previousServer.version)
    || (!!serverName && serverName !== previousServer.name)
    || (!!mapName && mapName !== previousServer.mapName)
    || !!dlcString
    || !!modString) {
    // send updated server information
    console.log('Previous:', previousServer.game, previousServer.version, previousServer.name, previousServer.mapName, previousDlcCount, previousModCount);
    console.log('Current:', game, version, serverName, mapName, dlcCount, modCount);

    string += `:tractor: Serveren **${serverName}** Er Blevet Opdateret: ${game} (${version}), **Map**: ${mapName}, **DLC${dlcCount !== 1 ? 's' : ''}**: ${dlcCount}, **Mod${modCount !== 1 ? 's' : ''}**: ${modCount}\n`;
    string += dlcString;
    string += modString;
  }

  const { money, playTime } = newData.careerSavegame;
  if (previousCareerSavegame.money !== money) {
    let directionEmoji = '';
    let moneyDifferenceSign = '';
    const moneyDifferenceAbsolute = Math.abs(money - previousCareerSavegame.money);

    if (money > previousCareerSavegame.money) {
      directionEmoji = ':arrow_up_small:';
      moneyDifferenceSign = '+';
    }
    if (money < previousCareerSavegame.money) {
      directionEmoji = ':arrow_down_small:';
      moneyDifferenceSign = '-';
    }
    let dk_money = Math.round(money * eur_kurs);
    let dk_money_diff = Math.round(moneyDifferenceAbsolute * eur_kurs);
    string += `:moneybag: Savegame Penge: ${directionEmoji} **${dk_money.toLocaleString('en-GB')} kr** (${moneyDifferenceSign}${dk_money_diff.toLocaleString('en-GB')} kr).\n`;
  }
  if (previousCareerSavegame.playTime !== playTime) {
    string += `:watch: Savegame Spillet Tid: **${formatMinutes(playTime)}**.\n`;
  }

  const { numUsed, capacity, players } = newData.slots;
  if (!_.isEqual(previousPlayers, players)) {
    const newPlayersArray = [];
    Object.values(players)
      .sort((playerA, playerB) => playerA.name.toLowerCase()
        .localeCompare(playerB.name.toLowerCase()))
      .forEach((player) => {
        if (!Object.prototype.hasOwnProperty.call(previousPlayers, player.name)) {
          newPlayersArray.push(player);
        }
      });
    const newPlayers = newPlayersArray
      .reduce((obj, player) => Object.assign(obj, { [player.name]: player }), {});

    const leftPlayersArray = [];
    Object.values(previousPlayers)
      .sort((playerA, playerB) => playerA.name.toLowerCase()
        .localeCompare(playerB.name.toLowerCase()))
      .forEach((player) => {
        if (!Object.prototype.hasOwnProperty.call(players, player.name)) {
          leftPlayersArray.push(player);
        }
      });
    const leftPlayers = leftPlayersArray
      .reduce((obj, player) => Object.assign(obj, { [player.name]: player }), {});

    if (Object.keys(newPlayers).length > 0 || Object.keys(leftPlayers).length > 0) {
      string += `:farmer: **${numUsed}** ud af ${capacity} spiller online${(numUsed > 0 ? `: **[1;2m[1;31m${formatPlayers(players)}[0m[0m**` : '')} (${getTimestamp()}).\n`;
    }

    if (Object.keys(newPlayers).length > 0) {
      console.log(newPlayers);
      string += `    :arrow_right: **${formatPlayers(newPlayers)}** har lige starte sit arbejde på gården.\n`;
    }

    Object.values(leftPlayers).forEach(({ name: playerName, firstSeen }) => {
      const playTimeInMinutes = Math.round((new Date().getTime() - firstSeen) / 60000);
      string += `    :arrow_left: **${playerName}** holder fri fra gården efter **${formatMinutes(playTimeInMinutes)}**.\n`;
    });
  }

  return string.trim() || null;
};

const sendMessage = (message) => {
  if (message) {
    client.channels.cache.filter((channel) => (
      // if we do not have a server name, or we do and it matches
      !process.env.FS22_BOT_DISCORD_SERVER_NAME
        || channel.guild.name === process.env.FS22_BOT_DISCORD_SERVER_NAME
    )
      // and if we do not have a channel name, or we do and it matches
      && (!process.env.FS22_BOT_DISCORD_CHANNEL_NAME
          || channel.name === process.env.FS22_BOT_DISCORD_CHANNEL_NAME)
      // channel is a text channel
      && channel.type === ChannelType.GuildText
      // we have permission to view and send
      && channel.guild.members.me.permissionsIn(channel)
        .has(PermissionsBitField.Flags.ViewChannel)
      && channel.guild.members.me.permissionsIn(channel)
        .has(PermissionsBitField.Flags.SendMessages)
      // channel can be sent to
      && channel.send).forEach((channel) => {
      console.log(`Sending message to: ${channel.guild.name}: ${channel.name}`);
      channel.send(message)
        .catch((error) => {
          console.error(error);
        });
    });
  }
};

const attemptPurge = () => {
  const now = new Date().getTime();
  if (willPurge() && now >= nextPurge) {
    // set next purge time
    nextPurge = getNextPurge();
    console.log('Looking for messages to purge...');
    try {
      purgeOldMessages(client);
    } catch (e) {
      console.error(e);
    }
    console.log(`Next purge will be ${new Date(nextPurge)}`);
  }
};

const update = () => {
  console.log('Updating...');
  getDataFromAPI()
    .then((rawData) => {
      try {
        const previouslyUnreachable = db.server.unreachable;
        const previousServer = db.server;
        const previousMods = db.mods;
        const previousPlayers = db.slots.players;
        const previousCareerSavegame = db.careerSavegame;

        const data = parseData(rawData, previousPlayers, previousServer);

        if (previouslyUnreachable) {
          if (process.env.FS22_BOT_DISABLE_UNREACHABLE_FOUND_MESSAGES !== 'true') {
            sendMessage(':thumbsup: Serveren er igen **online**.');
          }
          db.server.unreachable = false;
        }

        if (data) {
          const updateString = getUpdateString(
            data,
            previousServer,
            previousMods,
            previousPlayers,
            previousCareerSavegame,
          );
          sendMessage(updateString);
          db = data;
        } else {
          if (previousServer.online) {
            sendMessage(':tools: Serveren er gået **offline**.');
          }

          db.server.online = false;
          db.server.unreachable = false;
          db.slots = {
            players: {},
            numUsed: 0,
            capacity: 0,
          };
        }

        if (data?.server?.online) {
          client.user.setActivity(`online: ${data.slots.numUsed}/${data.slots.capacity}`);
        } else {
          client.user.setActivity('offline');
        }

        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
      } catch (e) {
        console.error(e);
      }
    })
    .catch((e) => {
      console.error(e);
      client.user.setActivity('unknown');
      if (!db.server.unreachable) {
        if (process.env.FS22_BOT_DISABLE_UNREACHABLE_FOUND_MESSAGES !== 'true') {
          sendMessage(':man_shrugging: Serveren er ikke **tilgængelig**.');
        }
        db.server.unreachable = true;
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
      }
    });

  attemptPurge();
};

client.on('ready', () => {
  if (willPurge()) {
    if (process.env.FS22_BOT_PURGE_DISCORD_CHANNEL_ON_STARTUP) {
      attemptPurge();
    } else {
      nextPurge = getNextPurge();
      console.log(`First purge will be ${new Date(nextPurge)}`);
    }
  }

  if (intervalTimer) {
    clearInterval(intervalTimer);
  }

  update();
  intervalTimer = setInterval(() => {
    update();
  }, pollIntervalMillis);
});

const initialise = () => {
  console.log(`Poll interval: ${pollIntervalMillis} milliseconds`);
  if (fs.existsSync(dbPath)) {
    try {
      db = merge(db, JSON.parse(fs.readFileSync(dbPath, 'utf8')));
      console.log(`Found: ${dbPath}`);
    } catch (e) {
      console.error(`Unable to read: ${dbPath}`);
    }
  } else {
    console.log(`New DB written: ${dbPath}`);
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  }

  client.login(process.env.FS22_BOT_DISCORD_TOKEN);
};

process.on('beforeExit', (code) => {
  console.log('Process beforeExit event with code: ', code);
});

onExit(() => {
  console.log('Logging out');
  client.destroy();
});

initialise();
