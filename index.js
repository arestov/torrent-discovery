module.exports = Discovery

var debug = require('debug')('torrent-discovery')
var DHT = require('bittorrent-dht/client') // empty object in browser
var EventEmitter = require('events').EventEmitter
var extend = require('xtend')
var inherits = require('inherits')
var parallel = require('run-parallel')
var reemit = require('re-emitter')
var Tracker = require('bittorrent-tracker/client')

inherits(Discovery, EventEmitter)

function Discovery (opts) {
  var self = this
  if (!(self instanceof Discovery)) return new Discovery(opts)
  EventEmitter.call(self)

  self.announce = opts.announce || []
  self.rtcConfig = opts.rtcConfig // browser only
  self.peerId = opts.peerId
  self.port = opts.port || 0 // torrent port
  self.wrtc = opts.wrtc
  self.intervalMs = opts.intervalMs || (15 * 60 * 1000)

  if (!self.peerId) throw new Error('peerId required')
  if (!process.browser && !self.port) throw new Error('port required')

  self.infoHash = null
  self.infoHashBuffer = null
  self.torrent = null

  self._dhtAnnouncing = false
  self._dhtTimeout = false
  self._internalDHT = false // is the DHT created internally?
  self._destroyers = []

  if (opts.tracker === false) {
    self.tracker = false
  } else {
    self.tracker = true
  }

  if (opts.dht === false) {
    self.dht = false
  } else if (typeof opts.dht === 'object') {
    self.dht = opts.dht
  } else {
    self.dht = createDHT()
  }

  if (self.dht) {
    addDestroyer(self, reemit(self.dht, self, ['error', 'warning']))
    listen(self.dht, 'peer', onPeer, self)
  }

  function createDHT () {
    if (typeof DHT !== 'function') return false
    self._internalDHT = true
    var dht = new DHT()
    dht.listen(opts.dhtPort)
    return dht
  }

  function onPeer (peer, infoHash) {
    if (infoHash.toString('hex') !== self.infoHash) return
    self.emit('peer', peer.host + ':' + peer.port)
  }
}

Discovery.prototype.setTorrent = function (torrent) {
  var self = this

  if (!self.infoHash && (typeof torrent === 'string' || Buffer.isBuffer(torrent))) {
    self.infoHash = typeof torrent === 'string'
      ? torrent
      : torrent.toString('hex')
  } else if (!self.torrent && torrent && torrent.infoHash) {
    self.torrent = torrent
    self.infoHash = typeof torrent.infoHash === 'string'
      ? torrent.infoHash
      : torrent.infoHash.toString('hex')
  } else {
    return
  }
  self.infoHashBuffer = new Buffer(self.infoHash, 'hex')

  debug('setTorrent %s', self.infoHash)

  // If tracker exists, then it was created with just infoHash. Set torrent length
  // so client can report correct information about uploads.
  if (self.tracker && self.tracker !== true) {
    self.tracker.torrentLength = torrent.length
  } else {
    self._createTracker()
  }

  self._dhtAnnounce()
}

Discovery.prototype.updatePort = function (port) {
  var self = this
  if (port === self.port) return
  self.port = port

  self._dhtAnnounce()

  if (self.tracker && self.tracker !== true) {
    self.tracker.stop()
    self.tracker.destroy(function () {
      self._createTracker()
    })
  }
}

Discovery.prototype.stop = function (cb) {
  var self = this
  var tasks = []
  clearTimeout(self._dhtTimeout)

  if (self.tracker && self.tracker !== true) {
    self.tracker.stop()
    tasks.push(function (cb) {
      self.tracker.destroy(cb)
    })
  }

  if (self._internalDHT) {
    tasks.push(function (cb) {
      self.dht.destroy(cb)
    })
  }
  parallel(tasks, cb)
}

Discovery.prototype._createTracker = function () {
  var self = this
  if (!self.tracker) return

  var torrent = self.torrent
    ? extend({ announce: [] }, self.torrent)
    : { infoHash: self.infoHash, announce: [] }

  if (self.announce) torrent.announce = torrent.announce.concat(self.announce)

  var trackerOpts = {
    rtcConfig: self.rtcConfig,
    wrtc: self.wrtc
  }

  self.tracker = new Tracker(self.peerId, self.port, torrent, trackerOpts)
  addDestroyer(self, reemit(self.tracker, self, ['peer', 'warning', 'error']))
  self.tracker.setInterval(self.intervalMs)
  listen(self.tracker, 'update', onUpdate, self)
  self.tracker.start()

  function onUpdate (data) {
    self.emit('trackerAnnounce', data)
  }
}

Discovery.prototype._dhtAnnounce = function () {
  var self = this
  if (!self.port || !self.infoHash || !self.dht || self._dhtAnnouncing) return

  self._dhtAnnouncing = true
  self.dht.announce(self.infoHash, self.port, function (err) {
    if (err) self.emit('warning', err)
    self._dhtAnnouncing = false

    debug('dht announce complete')
    self.emit('dhtAnnounce')
  })

  clearTimeout(self._dhtTimeout)
  self._dhtTimeout = setTimeout(function () {
    self._dhtAnnounce()
  }, getRandomTimeout())

  // Returns timeout interval, with some random jitter
  function getRandomTimeout () {
    return self.intervalMs + Math.floor(Math.random() * self.intervalMs / 5)
  }
}

function addDestroyer(target, item) {
  target._destroyers.push(item)
}

function listen (source, eventName, cb, target, once) {
  var destroyer = function () {
    source.removeListener(eventName, cb)
  }
  addDestroyer(target, destroyer)
  source[ once ? 'once' : 'on'](eventName, cb)
  return destroyer
}
