/* eslint-disable no-underscore-dangle */
/* eslint-disable no-restricted-syntax */
/* eslint-disable no-cond-assign */
/* eslint-disable max-len */
/* eslint-disable no-param-reassign */
const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');
const Utils = require('@sentry/utils');
const Core = require('@sentry/core');
const tslib = require('tslib');
const cookie = require('cookie');
const pluralize = require('pluralize');
const url = require('url');

function extractRequestData(req, keys) {
  const DEFAULT_REQUEST_KEYS = ['cookies', 'data', 'headers', 'method', 'query_string', 'url'];

  if (keys === undefined) { keys = DEFAULT_REQUEST_KEYS; }
  const requestData = {};
  // headers:
  //   node, express: req.headers
  //   koa: req.header
  const headers = (req.headers || req.header || {});
  // method:
  //   node, express, koa: req.method
  const { method } = req;
  // host:
  //   express: req.hostname in > 4 and req.host in < 4
  //   koa: req.host
  //   node: req.headers.host
  const host = req.hostname || req.host || headers.host || '<no host>';
  // protocol:
  //   node: <n/a>
  //   express, koa: req.protocol
  const protocol = req.protocol === 'https' || req.secure || (req.socket || {}).encrypted
    ? 'https'
    : 'http';
  // url (including path and query string):
  //   node, express: req.originalUrl
  //   koa: req.url
  const originalUrl = (req.originalUrl || req.url || '');
  // absolute url
  const absoluteUrl = `${protocol}://${host}${originalUrl}`;
  keys.forEach((key) => {
    switch (key) {
      case 'headers':
        requestData.headers = headers;
        break;
      case 'method':
        requestData.method = method;
        break;
      case 'url':
        requestData.url = absoluteUrl;
        break;
      case 'cookies':
        // cookies:
        //   node, express, koa: req.headers.cookie
        //   vercel, sails.js, express (w/ cookie middleware): req.cookies
        requestData.cookies = req.cookies || cookie.parse(headers.cookie || '');
        break;
      case 'query_string':
        // query string:
        //   node: req.url (raw)
        //   express, koa: req.query
        requestData.query_string = url.parse(originalUrl || '', false).query;
        break;
      case 'data':
        if (method === 'GET' || method === 'HEAD') {
          break;
        }
        // body data: express, koa: req.body
        // when using node by itself, you have to read the incoming stream(see
        // https://nodejs.dev/learn/get-http-request-body-data-using-nodejs); if a user is doing that, we can't know
        if (req.body !== undefined) {
          requestData.data = Utils.isString(req.body) ? req.body : JSON.stringify(Utils.normalize(req.body));
        }
        break;
      default:
        if ({}.hasOwnProperty.call(req, key)) {
          requestData[key] = req[key];
        }
    }
  });
  return requestData;
}

function extractExpressTransactionName(req, options) {
  if (options === undefined) { options = {}; }
  let _a;
  const method = (_a = req.method) === null || _a === undefined ? undefined : _a.toUpperCase();
  let path = '';
  if (req.route) {
    path = `${req.baseUrl || ''}${req.route.path}`;
  } else if (req.originalUrl || req.url) {
    path = Utils.stripUrlQueryAndFragment(req.originalUrl || req.url || '');
  }
  let info = '';
  if (options.method && method) {
    info += method;
  }
  if (options.method && options.path) {
    info += ' ';
  }
  if (options.path && path) {
    info += path;
  }
  return info;
}

module.exports = (app, dsn) => {
  Sentry.init({
    dsn,
    integrations: [
      // enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // enable Express.js middleware tracing
      new Tracing.Integrations.Express({
      // to trace all requests to the default router
        app,
      // alternatively, you can specify the routes you want to trace:
      // router: someRouter,
      }),
    ],

    // We recommend adjusting this value in production, or using tracesSampler
    // for finer control
    tracesSampleRate: 1.0,

    environment: process.env.NODE_ENV,
  });

  function addExpressReqToTransaction(transaction, req) {
    if (!transaction) { return; }
    transaction.name = extractExpressTransactionName(req, { path: true, method: true });
    transaction.setData('url', req.originalUrl);
    transaction.setData('baseUrl', req.baseUrl);
    transaction.setData('query', req.query);
  }

  // RequestHandler creates a separate execution context using domains, so that every
  // transaction/span/breadcrumb is attached to its own Hub instance
  app.use(Sentry.Handlers.requestHandler());
  // TracingHandler creates a trace for every incoming request
  app.use((req, res, next) => {
    // If there is a trace header set, we extract the data from it (parentSpanId, traceId, and sampling decision)
    let traceparentData;
    if (req.headers && Utils.isString(req.headers['sentry-trace'])) {
      traceparentData = Tracing.extractTraceparentData(req.headers['sentry-trace']);
    }
    const name = extractExpressTransactionName(req, { path: true, method: true });
    const transaction = Core.startTransaction(tslib.__assign({ name, op: 'http.server' }, traceparentData),
    // extra context passed to the tracesSampler
      { request: extractRequestData(req) });

    const path = extractExpressTransactionName(req, { path: true });
    const pathSplit = path.split('/');
    for (const index in pathSplit) {
      if (/^:/.test(pathSplit[index])) {
        const param = pluralize.singular(pathSplit[index - 1]).toLocaleLowerCase();
        const value = req.params[pathSplit[index].slice(1)];

        if (/id$/.test(pathSplit[index].toLocaleLowerCase())) {
          transaction.setTag([param, 'Id'].join(''), value);
        } else {
          transaction.setTag(param, value);
        }
      }
    }

    // We put the transaction on the scope so users can attach children to it
    Core.getCurrentHub().configureScope((scope) => {
      scope.setSpan(transaction);
    });
    // We also set __sentry_transaction on the response so people can grab the transaction there to add
    // spans to it later.
    res.__sentry_transaction = transaction;
    res.once('finish', () => {
      // Push `transaction.finish` to the next event loop so open spans have a chance to finish before the transaction
      // closes
      setImmediate(() => {
        addExpressReqToTransaction(transaction, req);
        transaction.setHttpStatus(res.statusCode);
        transaction.finish();
      });
    });
    next();
  });
};
