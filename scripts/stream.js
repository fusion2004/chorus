// Description:
//   Manages listening parties for Compoverse compo rounds (discord messages and shoutcast streams)
//
// Dependencies:
//   "<module name>": "<module version>"
//
// Configuration:
//   HUBOT_STREAM_HOST
//   HUBOT_STREAM_PORT
//   HUBOT_STREAM_MOUNT
//   HUBOT_STREAM_SOURCE_PASSWORD
//   HUBOT_COMPO_ADMIN_IDS
//
// Commands:
//   hubot start party <Round ID> - Starts a listening party for a compo round
//   hubot skip song - Skips the currently playing song and starts the next song
//   hubot stop party - Stops the currently listening party
//
// Notes:
//   <optional notes required for the script>
//
// Author:
//   fusion2004

const colors = require('colors');

const { store, streamUpdater } = require('../lib/chorus-store');
const StreamManager = require('../lib/stream_manager');
const fetchEnv = require('../utils/fetch-env');

// importing colors extends the String prototype so we can call these directly
// on strings: 'something went wrong'.error
colors.setTheme({
  info: 'blue',
  help: 'cyan',
  warn: 'yellow',
  success: 'green',
  error: 'red'
});

function lastAccessed(brain) {
  let data = brain.get('lastAccessed');
  if (!data) {
    data = {};
    brain.set('lastAccessed', data);
  }

  return data;
}

let adminIds = fetchEnv('HUBOT_COMPO_ADMIN_IDS').split(',');

function isAdmin(id) {
  return adminIds.includes(id);
}

module.exports = function(robot) {
  let discord = robot.adapter.client;

  discord.user.setActivity(null).catch(function(err) {
    console.log(err);
  });

  robot.respond(/start party (.*)/i, function(res) {
    let [, round] = res.match;
    let { room, user } = res.envelope;
    let channel = discord.channels.get(room);

    if (!isAdmin(user.id)) {
      res.send('You are not allowed to do that.');
      return;
    }

    let currentStream = store.state.context.stream.manager;
    if (currentStream && !currentStream.stopped) {
      res.send('There is currently a listening party streaming. We can only stream one at a time.');
      return;
    }

    let streamManager = new StreamManager(round);
    store.send(streamUpdater.update({ manager: streamManager, channel }));

    streamManager.on('intro', function() {
      res.send('**Playing stream intro before we get this party started...**');
    });

    streamManager.on('playing', function(song) {
      res.send(`**Playing "${song.title}" by ${song.artist}...**`);
    });

    streamManager.on('compoMetadataFetching', function() {
      res.send(`*Gathering round ${round} metadata...*`);
    });
    streamManager.on('fetchingSongs', function() {
      res.send(`*Downloading ${round} songs...*`);
    });
    streamManager.on('transcodingSongs', function() {
      res.send(`*Transcoding ${round} songs for streaming...*`);
    });
    streamManager.on('generatingAnnouncer', function() {
      res.send('*Clearing throat, performing vocal exercises...*');
    });

    streamManager.on('finish', function() {
      discord.user.setActivity('nothing...');
      res.send('**Finished playing...**');
    });

    streamManager.on('startingStream', function() {
      res.send(`**Starting stream... ${streamManager.streamUrl()}**`);
    });

    discord.user.setActivity(`in #${channel.name}`);
    streamManager.start();
  });

  robot.respond(/stop party/i, function(res) {
    if (!isAdmin(res.envelope.user.id)) {
      res.send('You are not allowed to do that.');
      return;
    }

    let currentStream = store.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      res.send('There is no listening party to stop!');
      return;
    }

    currentStream.stop();
  });

  robot.respond(/skip song/i, function(res) {
    if (!isAdmin(res.envelope.user.id)) {
      res.send('You are not allowed to do that.');
      return;
    }

    let currentStream = store.state.context.stream.manager;
    if (!currentStream || currentStream.stopped) {
      res.send('There is no listening party, currently!');
      return;
    }

    currentStream.skipSong();
  });

  robot.respond(/debug me/i, function(res) {
    let { user } = res.envelope;
    let userAccess = lastAccessed(robot.brain)[user.id];
    if (!userAccess) {
      userAccess = lastAccessed(robot.brain)[user.id] = {};
    }
    res.send(`you are user id "${user.id}" (type: ${typeof user.id}), known as "${user.name}"`);
    res.send(`you last ran this command on ${userAccess.time}`);
    console.log(res.envelope.room);
    console.log('FIND ME MARK');
    // let channel = discord.channels.get(res.envelope.room);

    console.log(discord.user.presence);
    // discord.user.setActivity(`in #${channel.name}`);
    console.log(discord.user.presence);
    // console.log(robot.brain.data);
    userAccess.time = new Date().toString();
  });

  robot.respond(/admin activity (.*)/i, function(res) {
    let [, activityName] = res.match;

    if (!isAdmin(res.envelope.user.id)) {
      res.send('You are not allowed to do that.');
      return;
    }

    discord.user.setActivity(activityName).then(function(user) {
      res.send(`Updated activity to '${user.localPresence.game.name}'`);
    }).catch(function(err) {
      res.send('Error occurred!');
      console.log(err);
    });
  });
};
