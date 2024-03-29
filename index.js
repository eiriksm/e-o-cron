'use strict'
var fs = require('fs')
const http = require('http')
const parallel = require('async/parallel')
const eos = require('e-o-store')
var util = require('util')
const queue = require('queue')
const https = require('https')

let q = queue()

var async = require('async')
var moment = require('moment')

var Eo = require('e-o')
var eon = require('e-o-notify')
var globalConfig = require('./config')
var store = require('e-o-store')
const bunyan = require('bunyan')
let log = bunyan.createLogger({name: 'queue-starter'})
if (!globalConfig) {
  // Should probably be thrown a long time ago, but just to be sure...
  throw new Error('Please configure this module.')
}
function RunLog (data) {
  this.log = log.child({url: data.url, mail: data.email})
  this.log.info('Creating a run log for', data.url)
}
var errors = [
  'down',
  'process',
  'resource'
]

var logger = function () {
  log.info.apply(log, arguments)
}

var deleteAndNotifyAboutChange = function (n, d, errorsInSite, callback) {
  async.each(errors, function (not, call) {
    if (!errorsInSite[not]) {
      // The site does not have this error. Make sure it is not marked
      // as such. But first check if this is a change or not.
      var storeKey = n.url + ':' + not
      store.get(storeKey, function (err, val) {
        if (err) {
          throw err
        }
        if (!val) {
          call()
          return
        }
        // This is a change, I guess. Notify about that.
        logger('Change for the better detected for %s regarding %s. Will notify %s about the good news', n.url, not, n.email)
        d.fixed = true
        eon('notify-' + not, d, n, function (err) {
          if (err) {
            logger(err)
          } else {
            store.del(storeKey, call)
          }
        })
      })
    } else {
      call()
    }
  }, function doneWithDeleting (err) {
    logger('Deleted all keys that are not active for', n.url)
    callback(err)
  })
}

function checkSite (config) {
  return function (callback) {
    var runLog = new RunLog(config)
    var n = config
    // Check this site.
    let eoconfig = {
      url: n.url,
      errors: {
        pageerror: true,
        resourceError: true
      },
      ignoreSsl: n.ignoreSsl,
      auth: n.auth,
      ignore: n.ignore
    }
    if (globalConfig.browserWSEndpoint) {
      eoconfig.browserWSEndpoint = globalConfig.browserWSEndpoint
    }
    var t = new Eo(eoconfig)
    // Ping into healthchecks.
    if (globalConfig.healthchecker) {
      runLog.log.info('Pinging healthckecker')
      https.get(globalConfig.healthchecker)
    }
    var notify = false
    var notifications = []
    t.on('error', function (type, d) {
      runLog.log.warn('Had an error of type %s in site %s', type, n.url)
      // Better notify then, I guess.
      notify = true
      notifications.push(type)
    })
    t.on('debug', function (d) {
      d.forEach((item) => {
        n.logs = n.logs || []
        n.logs.push({
          type: item.type,
          timestamp: item.timestamp,
          message: item.message
        })
      })
    })
    t.on('end', function (d) {
      runLog.log.info('Process ended for site', n.url)
      var errorsInSite = {}
      if (notify) {
        // Add the logs to the n objecct.
        n.logs = n.logs || []
        n.logs = n.logs.concat(d.logs)
        var nots = []
        // See if this is the first run.
        var maxRuns = n.maxRuns || 3
        if (!n.checks || n.checks < maxRuns) {
          if (isNaN(n.checks)) {
            n.checks = 1
          }
          n.checks++
          var msg = util.format('Starting run number %d of %s', n.checks, n.url)
          runLog.log.info(msg)
          n.logs.push({
            type: 'SYSTEM',
            timestamp: Date.now(),
            message: msg
          })
          return checkSite(n)(callback)
        }
        d.numbers.retries = n.checks
        d.logs = n.logs
        notifications.forEach(function (not) {
          runLog.log.info('Checking status of notification', not)
          nots.push(function (cb) {
            errorsInSite[not] = true
            // See if the site is currently in that state.
            var storeKey = n.url + ':' + not
            store.get(storeKey, function (err, val) {
              if (err) {
                throw err
              }
              if (val) {
                // We have already notified.
                var timeAgo = moment(parseInt(val, 10)).fromNow()
                runLog.log.info('Skipping notification of %s for site %s because we already sent it %s',
                       not, n.url, timeAgo)
                cb()
              } else {
                store.set(storeKey, Date.now(), function () {
                  runLog.log.info('Notifying %s about the fact that %s had the error %s', n.email, n.url, not)
                  eon('notify-' + not, d, n, cb)
                })
              }
            })
          })
        })
        async.parallel(nots, function () {
          runLog.log.info('Sent all notifications for', n.url)
          // Delete keys that are not active still.
          deleteAndNotifyAboutChange(n, d, errorsInSite, callback)
        })
      }
      if (!notify) {
        runLog.log.info('No errors for', n.url)
        deleteAndNotifyAboutChange(n, d, {}, function () {
          if (d.screenshot) {
            fs.unlink(d.screenshot.trim(), callback)
          } else {
            callback()
          }
        })
      }
    })
    t.start()
  }
}

setInterval(_ => {
  function createTask (site) {
    return function (callback) {
      eos.append(JSON.stringify(site), callback)
    }
  }
  var tasks = []
  globalConfig.sites.forEach(site => {
    tasks.push(createTask(site))
  })
  parallel(tasks, (err, res) => {
    if (err) throw err
  })
}, globalConfig.interval ?? 60 * 1000)

store.listen((channel, message) => {
  logger('Got notification for change')
  let messageSite
  try {
    messageSite = JSON.parse(message)
  } catch (error) {
    logger('Problem with a message received')
    return
  }
  logger('Adding something to the queue: ', messageSite.url)
  q.push(checkSite(messageSite))
  q.start()
})

q.concurrency = 1
q.on('end', (err) => {
  if (err) {
    throw err
  }
  logger('Queue end')
})
const ks = require('kill-switch')(globalConfig.killSecret, globalConfig.killPort)
ks.start()

let server
const startIt = (cb) => {
  server = http.createServer((req, res) => {
    if (req.url === util.format('/data/%s', globalConfig.killSecret)) {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        config: globalConfig,
        data: eos.all()
      }))
      return
    }
    res.statusCode = 403
    res.setHeader('Content-Type', 'text/plain')
    res.end()
  })

  server.listen(3000, '0.0.0.0', _ => {
    console.log('server lsitening yeah')
  })
}
startIt()