StreamManager = require('../lib/stream_manager');

module.exports = (robot) ->
  robot.respond /play stream/i, (res) ->
    streamManager = new StreamManager()

    # streamManager.on 'startSong', (song) ->
    #   res.send 'Playing song \'' + song.name + '\''

    streamManager.on 'finish', ->
      res.send 'Finished playing...'

    msg = 'Starting stream... ' + streamManager.streamUrl()
    res.send msg
    res.send 'Playing song...'

    streamManager.start()
