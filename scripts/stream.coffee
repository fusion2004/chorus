nodeshout = require('nodeshout')

nodeshout.init()

console.log('Libshout version: ' + nodeshout.getVersion())

module.exports = (robot) ->
  robot.respond /play stream/i, (res) ->
    shout = nodeshout.create()
    host = 'localhost'
    port = 8000
    mount = 'stream'

    msg = 'Starting stream... ' + 'http://' + host + ':' + port + '/' + mount + '.m3u'
    res.send msg

    shout.setHost(host)
    shout.setPort(port)
    shout.setUser('source')
    shout.setPassword('hackme')
    shout.setMount(mount);
    shout.setFormat(1) # 0=ogg, 1=mp3
    shout.setAudioInfo('bitrate', '192')
    shout.setAudioInfo('samplerate', '44100')
    shout.setAudioInfo('channels', '2')

    shout.open()

    res.send 'Playing song...'

    # Create file read stream and shout stream
    fileStream = new nodeshout.FileReadStream('./music/01.mp3', 65536);
    shoutStream = fileStream.pipe(new nodeshout.ShoutStream(shout));

    fileStream.on 'data', (chunk) ->
      # console.log('Read %d bytes of data', chunk.length)

    shoutStream.on 'finish', () ->
      console.log('Finished playing...')
      res.send 'Finished playing...'

      shout.close()
