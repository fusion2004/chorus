// Description:
//   <description of the scripts functionality>
//
// Dependencies:
//   "<module name>": "<module version>"
//
// Configuration:
//   LIST_OF_ENV_VARS_TO_SET
//
// Commands:
//   hubot start party <Round ID> - Starts a listening party for a compo round
//
// Notes:
//   <optional notes required for the script>
//
// Author:
//   <github username of the original script author>

const StreamManager = require('../lib/stream_manager');

function lastAccessed(brain) {
  let data = brain.get('lastAccessed');
  if (!data) {
    data = {};
    brain.set('lastAccessed', data);
  }

  return data;
}

module.exports = function(robot) {
  robot.respond(/start party (.*)/i, function(res) {
    let msg;
    let [, round] = res.match;
    let streamManager = new StreamManager(round);

    streamManager.on('finish', function() {
      return res.send('Finished playing...');
    });

    msg = `Starting stream... ${streamManager.streamUrl()}`;
    res.send(msg);
    res.send('Playing song...');

    return streamManager.start();
  });

  robot.respond(/debug me/i, function(res) {
    let { user } = res.envelope;
    let userAccess = lastAccessed(robot.brain)[user.id];
    if (!userAccess) {
      userAccess = lastAccessed(robot.brain)[user.id] = {};
    }
    res.send(`you are user id "${user.id}", known as "${user.name}"`);
    res.send(`you last ran this command on ${userAccess.time}`);
    console.log(robot.brain.data);
    userAccess.time = new Date().toString();
  });
};
