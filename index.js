/* eslint-disable no-restricted-syntax */
/* eslint-disable no-param-reassign */
/* eslint-disable no-cond-assign */
/* eslint-disable no-void */
/* eslint-disable no-underscore-dangle */
/* eslint-disable no-undef */
/* eslint-disable max-len */
const Sentry = require('@sentry/node');
const Tracing = require('@sentry/tracing');
const Utils = require('@sentry/utils');
const Core = require('@sentry/core');
const tslib = require('tslib');
const pluralize = require('pluralize');

function extractExpressTransactionName(req, options) {
  if (options === void 0) { options = {}; }
  let _a;
  const method = (_a = req.method) === null || _a === void 0 ? void 0 : _a.toUpperCase();
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
