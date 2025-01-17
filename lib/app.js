#!/usr/bin/env node

/*
 * Jinji highly-compatible wiki engine
 * https://github.com/queenkjuul/jinji
 * forked from:
 * https://github.com/claudioc/jingo
 *
 * Copyright 2025 Julie Hill <queenkjuul@pm.me>
 * Copyright 2013-2017 Claudio Cicali <claudio.cicali@gmail.com>
 * Released under the MIT license
 */

var express = require('express')
var path = require('path')
var components = require('./components')
var wikiStatic = require('./wikistatic')
var favicon = require('serve-favicon')
var session = require('express-session')
var bodyParser = require('body-parser')
var cookieParser = require('cookie-parser')
var logger = require('morgan')
var { program } = require('commander')
var cookieSession = require('cookie-session')
var gravatar = require('gravatar')
var passport = require('passport')
var methodOverride = require('method-override')
var flash = require('express-flash')
const { isRetroUserAgent, getIconForFilename, formatBytes } = require('./tools')
const serveIndex = require('serve-index')
const { renderFile } = require('pug')
const namer = require('./namer')

var app

module.exports.getInstance = function () {
  if (!app) {
    throw new Error('Cannot get an instance of an unitialized App')
  }
  return app
}

module.exports.initialize = function (config) {
  app = express()

  app.locals.config = config

  app.locals.baseUrl = '//' + config.get('server').hostname + ':' + config.get('server').port

  if (config.get('server').baseUrl === '') {
    app.locals.baseUrl = '//' + config.get('server').hostname + ':' + config.get('server').port
  } else {
    app.locals.baseUrl = config.get('server').baseUrl
  }

  // View helpers
  app.use(function (req, res, next) {
    res.locals = {
      get user() {
        return req.user
      },
      get appBrand() {
        var appTitle = config.get('application').title || ''
        var appLogo = config.get('application').logo || ''
        if (appLogo !== '') {
          appLogo = '<img src="' + appLogo + '" alt="Logo">'
        }
        return appLogo + ' ' + appTitle
      },
      get proxyPath() {
        return config.getProxyPath()
      },
      get jinjiVersion() {
        return program.version()
      },
      get authentication() {
        return config.get('authentication')
      },
      get faviconMimeType() {
        if (!this.hasFavicon()) {
          return ''
        }
        var favicon = config.get('application').favicon.trim()
        var match = favicon.match(/\.([0-9a-z]+)$/i)
        return match ? 'image/' + match[1] : 'image/png'
      },
      get faviconUrl() {
        if (!this.hasFavicon()) {
          return ''
        }
        return config.get('application').favicon.trim()
      },

      isAnonymous: function () {
        return !req.user
      },
      canSearch: function () {
        return !!req.user || app.locals.config.get('authorization').anonRead
      },
      gravatar: function (email) {
        return gravatar
      },
      hasGravatar: function () {
        return (
          config.get('features').gravatar &&
          req.user &&
          req.user.email &&
          req.user.email !== 'jingouser'
        )
      },
      hasFavicon: function () {
        return (
          config.get('application').favicon && config.get('application').favicon.trim().length > 0
        )
      },
      get isAjax() {
        return (
          req.headers['x-requested-with'] && req.headers['x-requested-with'] === 'XMLHttpRequest'
        )
      },
      get ua() {
        return req.get('User-Agent')
      },
      get noscript() {
        return isRetroUserAgent(req.get('User-Agent'))
      },
      get namer() {
        return namer
      },
    }
    next()
  })

  app.locals.coalesce = function (value, def) {
    return typeof value === 'undefined' ? def : value
  }

  app.locals.pretty = true // Pretty HTML output from Pug

  app.locals.hasSidebar = components.hasSidebar
  app.locals.hasFooter = components.hasFooter
  app.locals.hasCustomStyle = components.hasCustomStyle
  app.locals.hasCustomScript = components.hasCustomScript
  app.locals.hasFeature = function (feature) {
    return !!app.locals.config.get('features')[feature]
  }

  if (components.hasCustomStyle()) {
    console.log('Using custom style ' + config.get('customizations')['style'])
  }

  if (components.hasCustomScript()) {
    console.log('Using custom script ' + config.get('customizations')['script'])
  }

  app.enable('trust proxy')
  if (config.get('application').loggingMode) {
    app.use(
      logger(config.get('application').loggingMode == 1 ? 'combined' : 'dev', {
        skip: function () {},
      })
    ) // eslint-disable-line
  }
  app.use(favicon(path.join(__dirname + '/../', 'public', 'favicon.ico'))) // eslint-disable-line no-path-concat
  app.use(bodyParser.urlencoded({ extended: true, limit: '500kb' }))
  app.use(
    methodOverride(function (req, res) {
      if (req.body && typeof req.body === 'object' && '_method' in req.body) {
        // look in urlencoded POST bodies and delete it
        var method = req.body._method
        delete req.body._method
        return method
      }
    })
  )

  app.use('/img/*.png', (req, res, next) => {
    if (isRetroUserAgent(req.headers['user-agent'])) {
      res.redirect(req.originalUrl.replace('.png', '.gif'))
      return
    }
    next()
  })
  app.use(express.static(path.join(__dirname + '/../public'))) // eslint-disable-line no-path-concat
  app.use(cookieParser())
  app.use(
    cookieSession({
      name: 'JingoSession',
      keys: ['jingo'],
      cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 },
    })
  )
  app.use(
    session({
      name: 'jingosid',
      secret: config.get('application').secret,
      cookie: { httpOnly: true },
      saveUninitialized: true,
      resave: true,
    })
  )
  app.use(flash())

  app.set('views', __dirname + '/../views') // eslint-disable-line no-path-concat
  app.set('view engine', 'pug')

  // Read this before disabling it https://github.com/strongloop/express/pull/2813#issuecomment-159270428
  app.set('x-powered-by', true)

  app.use(function (req, res, next) {
    res.locals._style = components.customStyle()
    res.locals._script = components.customScript()

    if (
      /^\/auth\//.test(req.url) ||
      /^\/misc\//.test(req.url) ||
      (/^\/login/.test(req.url) && !config.get('authorization').anonRead)
    ) {
      return next()
    }

    components
      .sidebarAsync()
      .then(function (content) {
        res.locals._sidebar = content
        return components.footerAsync()
      })
      .then(function (content) {
        res.locals._footer = content
        return next()
      })
      .catch(function (e) {
        console.log(e)
      })
  })

  app.use(passport.initialize())
  app.use(passport.session())

  app.locals.passport = passport

  function requireAuthentication(req, res, next) {
    if (!res.locals.user) {
      res.redirect(res.locals.proxyPath + '/login')
    } else {
      next()
    }
  }

  app.all('/pages/*', requireAuthentication)
  app.all('/upload*', requireAuthentication)

  if (!app.locals.config.get('authorization').anonRead) {
    app.all('/wiki', requireAuthentication)
    app.all('/wiki/*', requireAuthentication)
    app.all('/search', requireAuthentication)
  }

  const staticFilesPath = path.join(app.locals.config.get('application').repository, '/files')

  app.use('/wiki', wikiStatic.configure())
  app
    .use(
      '/files',
      express.static(staticFilesPath, {
        dotfiles: 'allow',
        index: false,
      }),
      (req, res, next) => {
        if (isRetroUserAgent(req.header('user-agent'))) {
          req.headers['accept'] = '*/*'
        }
        serveIndex(staticFilesPath, {
          icons: true,
          hidden: true,
          view: 'details',
          template: (locals, callback) => {
            var html
            try {
              html = renderFile('views/filelist.pug', {
                ...app.locals,
                ...res.locals,
                ...locals,
                url: req.url,
                getIconForFilename,
                formatBytes,
              })
            } catch (e) {
              callback(e, '500 - Internal Server Error')
              return
            }
            callback(null, html)
          },
        })(req, res, next)
      }
    )
    .use('/files/*index.html', (req, res) => {
      res.render('directory', { src: '/files' + req.url })
      next()
    })

  app
    .use(require('../routes/wiki'))
    .use(require('../routes/pages'))
    .use(require('../routes/search'))
    .use(require('../routes/auth'))
    .use(require('../routes/misc'))
    .use(require('../routes/upload'))

  app.all('*', function (req, res) {
    res.locals.title = '404 - Not found'
    res.statusCode = 404
    res.render('404.pug')
  })

  // Server error
  app.use(function (err, req, res, next) {
    res.locals.title = '500 - Internal server error'
    res.statusCode = 500
    console.log(err)
    res.render('500.pug', {
      message:
        'Sorry, something went wrong and I cannot recover. If you think this might be a bug in Jinji, please file a detailed report about what you were doing here: https://github.com/queenkjuul/jinji/issues . Thank you!',
      error: err,
    })
  })

  return app
}
