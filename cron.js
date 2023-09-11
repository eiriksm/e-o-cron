const eos = require('e-o-store')
const redis = require('redis')
const queueKey = 'eoqueue'
const config = require('./config')
const parallel = require('async/parallel')
let client = redis.createClient(config.redisConnection)
eos.start(config.redisConnection)

function createTask (site) {
  return function (callback) {
    eos.append(JSON.stringify(site), callback)
  }
}

client.llen(queueKey, (err, res) => {
  if (err) throw err
  if (!res) {
    var tasks = []
    config.sites.forEach(site => {
      tasks.push(createTask(site))
    })
    parallel(tasks, (err, res) => {
      if (err) throw err
      eos.shutdown()
    })
  }
  client.quit()
})
