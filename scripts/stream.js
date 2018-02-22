StreamManager = require('../lib/stream_manager');

module.exports = (robot) ->
  robot.respond /start party (.*)/i, (res) ->
    round = res.match[1]
    streamManager = new StreamManager(round)

    # streamManager.on 'startSong', (song) ->
    #   res.send 'Playing song \'' + song.name + '\''

    streamManager.on 'finish', ->
      res.send 'Finished playing...'

    msg = 'Starting stream... ' + streamManager.streamUrl()
    res.send msg
    res.send 'Playing song...'

    streamManager.start()
