'use strict'
const config = require('./config')
const util = require('util')
require('http')
.get(util.format('http://localhost:%d/%s', config.killPort, config.killSecret), (resp) => {})
