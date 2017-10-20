'use strict';

const assert = require('assert');
const debug = require('debug')('koa-joi-router');
const isGenFn = require('is-gen-fn');
const flatten = require('flatten');
const methods = require('methods');
const KoaRouter = require('koa-router');
const busboy = require('co-busboy');
const parse = require('co-body');
const Joi = require('joi');
const slice = require('sliced');
const delegate = require('delegates');
const clone = require('clone');
const OutputValidator = require('./output-validator');

module.exports = Router;

// expose Joi for use in applications
Router.Joi = Joi;

function Router() {
  if (!(this instanceof Router)) {
    return new Router();
  }

  this.routes = [];
  this.router = new KoaRouter();
}

/**
 * Array of routes
 *
 * Router.prototype.routes;
 * @api public
 */

/**
 * Delegate methods to internal router object
 */

delegate(Router.prototype, 'router')
  .method('prefix')
  .method('use')
  .method('param');

/**
 * Return koa middleware
 * @return {Function}
 * @api public
 */

Router.prototype.middleware = function middleware() {
  return this.router.routes();
};

/**
 * Adds a route or array of routes to this router, storing the route
 * in `this.routes`.
 *
 * Example:
 *
 *   var admin = router();
 *
 *   admin.route({
 *     method: 'get',
 *     path: '/do/stuff/:id',
 *     handler: function *(next){},
 *     validate: {
 *       header: Joi object
 *       params: Joi object (:id)
 *       query: Joi object (validate key/val pairs in the querystring)
 *       body: Joi object (the request payload body) (json or form)
 *       maxBody: '64kb' // (json, x-www-form-urlencoded only - not stream size)
 *                       // optional
 *       type: 'json|form|multipart' (required when body is specified)
 *       failure: 400 // http error code to use
 *     },
 *     meta: { // this is ignored but useful for doc generators etc
 *       desc: 'We can use this for docs generation.'
 *       produces: ['application/json']
 *       model: {} // response object definition
 *     }
 *   })
 *
 * @param {Object} spec
 * @return {Router} self
 * @api public
 */

Router.prototype.route = function route(spec) {
  if (Array.isArray(spec)) {
    for (let i = 0; i < spec.length; i++) {
      this._addRoute(spec[i]);
    }
  } else {
    this._addRoute(spec);
  }

  return this;
};

/**
 * Adds a route to this router, storing the route
 * in `this.routes`.
 *
 * @param {Object} spec
 * @api private
 */

Router.prototype._addRoute = function addRoute(spec) {
  this._validateRouteSpec(spec);
  this.routes.push(spec);

  debug('add %s "%s"', spec.method, spec.path);

  const bodyParser = makeBodyParser(spec);
  const specExposer = makeSpecExposer(spec);
  const validator = makeValidator(spec);
  const handlers = flatten(spec.handler);

  const args = [
    spec.path,
    prepareRequest,
    specExposer,
    bodyParser,
    validator
  ].concat(handlers);

  const router = this.router;

  spec.method.forEach((method) => {
    router[method].apply(router, args);
  });
};

/**
 * Validate the spec passed to route()
 *
 * @param {Object} spec
 * @api private
 */

Router.prototype._validateRouteSpec = function validateRouteSpec(spec) {
  assert(spec, 'missing spec');

  const ok = typeof spec.path === 'string' || spec.path instanceof RegExp;
  assert(ok, 'invalid route path');

  checkHandler(spec);
  checkMethods(spec);
  checkValidators(spec);
};

/**
 * @api private
 */

function checkHandler(spec) {
  if (!Array.isArray(spec.handler)) {
    spec.handler = [spec.handler];
  }

  return flatten(spec.handler).forEach(isGeneratorFunction);
}

/**
 * @api private
 */

function isGeneratorFunction(handler) {
  assert(isGenFn(handler), 'route handler must be a GeneratorFunction');
}

/**
 * Validate the spec.method
 *
 * @param {Object} spec
 * @api private
 */

function checkMethods(spec) {
  assert(spec.method, 'missing route methods');

  if (typeof spec.method === 'string') {
    spec.method = spec.method.split(' ');
  }

  if (!Array.isArray(spec.method)) {
    throw new TypeError('route methods must be an array or string');
  }

  if (spec.method.length === 0) {
    throw new Error('missing route method');
  }

  spec.method.forEach((method, i) => {
    assert(typeof method === 'string', 'route method must be a string');
    spec.method[i] = method.toLowerCase();
  });
}

/**
 * Validate the spec.validators
 *
 * @param {Object} spec
 * @api private
 */

function checkValidators(spec) {
  if (!spec.validate) return;

  let text;
  if (spec.validate.body) {
    text = 'validate.type must be declared when using validate.body';
    assert(/json|form/.test(spec.validate.type), text);
  }

  if (spec.validate.type) {
    text = 'validate.type must be either json, form, multipart or stream';
    assert(/json|form|multipart|stream/i.test(spec.validate.type), text);
  }

  if (spec.validate.output) {
    spec.validate._outputValidator = new OutputValidator(spec.validate.output);
  }

  // default HTTP status code for failures
  if (!spec.validate.failure) {
    spec.validate.failure = 400;
  }
}

/**
 * Creates body parser middleware.
 *
 * @param {Object} spec
 * @return {GeneratorFunction}
 * @api private
 */

function makeBodyParser(spec) {
  return function* parsePayload(next) {
    if (!(spec.validate && spec.validate.type)) return yield* next;

    let opts;

    try {
      switch (spec.validate.type) {
        case 'json':
          if (!this.request.is('json')) {
            return this.throw(400, 'expected json');
          }

          opts = {
            limit: spec.validate.maxBody
          };

          this.request.body = yield parse.json(this, opts);
          break;

        case 'form':
          if (!this.request.is('urlencoded')) {
            return this.throw(400, 'expected x-www-form-urlencoded');
          }

          opts = {
            limit: spec.validate.maxBody
          };

          this.request.body = yield parse.form(this, opts);
          break;

        case 'stream':
        case 'multipart':
          if (!this.request.is('multipart/*')) {
            return this.throw(400, 'expected multipart');
          }

          opts = spec.validate.multipartOptions || {}; // TODO document this
          opts.autoFields = true;

          this.request.parts = busboy(this, opts);
          break;
      }
    } catch (err) {
      if (!spec.validate.continueOnError) return this.throw(err);
      captureError(this, 'type', err);
    }

    yield* next;
  };
}

/**
 * @api private
 */

function captureError(ctx, type, err) {
  // expose Error message to JSON.stringify()
  err.msg = err.message;
  if (!ctx.invalid) ctx.invalid = {};
  ctx.invalid[type] = err;
}

/**
 * Creates validator middleware.
 *
 * @param {Object} spec
 * @return {GeneratorFunction}
 * @api private
 */

function makeValidator(spec) {
  const props = 'header query params body'.split(' ');

  return function* validator(next) {
    let err;

    if (!spec.validate) return yield* next;

    for (let i = 0; i < props.length; ++i) {
      const prop = props[i];

      if (spec.validate[prop]) {
        err = validateInput(prop, this, spec.validate);

        if (err) {
          if (!spec.validate.continueOnError) return this.throw(err);
          captureError(this, prop, err);
        }
      }
    }

    yield* next;

    if (spec.validate._outputValidator) {
      debug('validating output');

      err = spec.validate._outputValidator.validate(this);
      if (err) {
        err.status = 500;
        return this.throw(err);
      }
    }
  };
}

/**
 * Exposes route spec.
 *
 * @param {Object} spec
 * @return {GeneratorFunction}
 * @api private
 */
function makeSpecExposer(spec) {
  const defn = clone(spec);
  return function* specExposer(next) {
    this.state.route = defn;
    yield* next;
  };
}

/**
 * Middleware which creates `request.params`.
 *
 * @api private
 */

function* prepareRequest(next) {
  this.request.params = this.params;
  yield* next;
}

/**
 * Validates request[prop] data with the defined validation schema.
 *
 * @param {String} prop
 * @param {koa.Request} request
 * @param {Object} validate
 * @returns {Error|undefined}
 * @api private
 */

function validateInput(prop, ctx, validate) {
  debug('validating %s', prop);

  const request = ctx.request;
  const res = Joi.validate(request[prop], validate[prop]);

  if (res.error) {
    res.error.status = validate.failure;
    return res.error;
  }

  // update our request w/ the casted values
  switch (prop) {
    case 'header': // request.header is getter only, cannot set it
    case 'query': // setting request.query directly causes casting back to strings
      Object.keys(res.value).forEach((key) => {
        request[prop][key] = res.value[key];
      });
      break;
    case 'params':
      request.params = ctx.params = res.value;
      break;
    default:
      request[prop] = res.value;
  }
}

/**
 * Routing shortcuts for all HTTP methods
 *
 * Example:
 *
 *    var admin = router();
 *
 *    admin.get('/user', function *() {
 *      this.body = this.session.user;
 *    })
 *
 *    var validator = Joi().object().keys({ name: Joi.string() });
 *    var config = { validate: { body: validator }};
 *
 *    admin.post('/user', config, function *(){
 *      console.log(this.body);
 *    })
 *
 *    function *commonHandler(){
 *      // ...
 *    }
 *    admin.post('/account', [commonHandler, function *(){
 *      // ...
 *    }]);
 *
 * @param {String} path
 * @param {Object} [config] optional
 * @param {GeneratorFunction|GeneratorFunction[]} handler(s)
 * @return {App} self
 */

methods.forEach((method) => {
  method = method.toLowerCase();

  Router.prototype[method] = function(path) {
    // path, handler1, handler2, ...
    // path, config, handler1
    // path, config, handler1, handler2, ...
    // path, config, [handler1, handler2], handler3, ...

    let fns;
    let config;

    if (typeof arguments[1] === 'function' || Array.isArray(arguments[1])) {
      config = {};
      fns = slice(arguments, 1);
    } else if (typeof arguments[1] === 'object') {
      config = arguments[1];
      fns = slice(arguments, 2);
    }

    const spec = {
      path: path,
      method: method,
      handler: fns
    };

    Object.keys(config).forEach((key) => {
      spec[key] = config[key];
    });

    this.route(spec);
    return this;
  };
});
