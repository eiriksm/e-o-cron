'use strict'
var fs = require('fs')
var util = require('util')
const queue = require('queue')

let q = queue()

var async = require('async')
var moment = require('moment')

var Eo = require('e-o')
var eon = require('e-o-notify')
var config = require('./config')
var store = require('e-o-store')
if (!config) {
  // Should probably be thrown a long time ago, but just to be sure...
  throw new Error('Please configure this module.')
}
var errors = [
  'down',
  'process',
  'resource'
]

var logger = function () {
  console.log.apply(console, arguments)
}

var deleteAndNotifyAboutChange = function (n, d, errorsInSite, callback) {
  async.each(errors, function (not, call) {
    if (!errorsInSite[not]) {
      // The site does not have this error. Make sure it is not marked
      // as such. But first check if this is a change or not.
      var storeKey = n.url + ':' + not
      store.get(storeKey, function (err, val) {
        if (!val) {
          call()
          return
        }
        // This is a change, I guess. Notify about that.
        logger('Change for the better detected for %s regarding %s. Will notify %s about the good news',
               n.url, not, n.email)
        d.fixed = true
        eon('notify-' + not, d, n, function (err) {
          if (err) {
            console.error(err)
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
    callback()
  })
}

function checkSite (config) {
  return function (callback) {
    var n = config
    // Check this site.
    var t = new Eo({
      url: n.url,
      errors: {
        pageerror: true,
        resourceError: true
      },
      ignoreSsl: n.ignoreSsl,
      ignore: n.ignore
    })
    var notify = false
    var notifications = []
    t.on('error', function (type, d) {
      logger('Had an error of type %s in site %s', type, n.url)
      // Better notify then, I guess.
      notify = true
      notifications.push(type)
    }),
    t.on('debug', function (d) {
    })
    t.on('end', function (d) {
      logger('Process ended for site', n.url)
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
          logger(msg)
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
          logger('Checking status of notification', not)
          nots.push(function (cb) {
            errorsInSite[not] = true
            // See if the site is currently in that state.
            var storeKey = n.url + ':' + not
            store.get(storeKey, function (err, val) {
              if (val) {
                // We have already notified.
                var timeAgo = moment(parseInt(val, 10)).fromNow()
                logger('Skipping notification of %s for site %s because we already sent it %s',
                       not, n.url, timeAgo)
                cb()
              } else {
                store.set(storeKey, Date.now(), function () {
                  logger('Notifying %s about the fact that %s had the error %s', n.email, n.url, not)
                  eon('notify-' + not, d, n, cb)
                })
              }
            })
          })
        })
        async.parallel(nots, function () {
          logger('Sent all notifications for', n.url)
          // Delete keys that are not active still.
          deleteAndNotifyAboutChange(n, d, errorsInSite, callback)
        })
      }
      if (!notify && d.screenshot) {
        logger('No errors for', n.url)
        deleteAndNotifyAboutChange(n, d, {}, function () {
          fs.unlink(d.screenshot.trim(), callback)
        })
      }
    })
    t.start()
  }
}

store.listen((channel, message) => {
  logger('Got notification for change')
  let messageSite
  try {
    messageSite = JSON.parse(message)
  }
  catch (error) {
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
const ks = require('kill-switch')(config.killSecret, config.killPort)
ks.start()
