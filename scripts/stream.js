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

module.exports = function(robot) {
  return robot.respond(/start party (.*)/i, function(res) {
    let msg;
    let round = res.match[1];
    let streamManager = new StreamManager(round);

    streamManager.on('finish', function() {
      return res.send('Finished playing...');
    });

    msg = 'Starting stream... ' + streamManager.streamUrl();
    res.send(msg);
    res.send('Playing song...');

    return streamManager.start();
  });
};
