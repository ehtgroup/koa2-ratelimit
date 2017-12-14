const Store = require('./Store.js');
const MemoryStore = require('./MemoryStore.js');

/* eslint-disable no-var */
var defaultOptions = {
    // window, delay, and max apply per-key unless global is set to true
    windowMs: 60 * 1000, // milliseconds - how long to keep records of requests in memory
    delayAfter: 0, // how many requests to allow through before starting to delay responses
    delayMs: 1000, // milliseconds - base delay applied to the response - multiplied by number of recent hits for the same key.
    max: 5, // max number of recent connections during `window` milliseconds before sending a 429 response

    message: 'Too many requests, please try again later.',
    statusCode: 429, // 429 status = Too Many Requests (RFC 6585)
    headers: true, // Send custom rate limit header with limit and remaining
    skipFailedRequests: false, // Do not count failed requests (status >= 400)
    prefixKey: 'global', // the prefixKey to get to remove all key

    store: new MemoryStore(),

    // redefin fonction
    keyGenerator: undefined,
    skip: undefined,
    getUserId: undefined,
    handler: undefined,
    onLimitReached: undefined,
};

class RateLimit {
    constructor(options) {
        this.options = Object.assign({}, defaultOptions, options);
        // store to use for persisting rate limit data
        this.store = this.options.store;

        // ensure that the store extends Store class
        if (!(this.store instanceof Store)) {
            throw new Error('The store is not valid.');
        }
    }

    async keyGenerator(ctx) {
        if (this.options.keyGenerator) {
            return this.options.keyGenerator(ctx);
        }
        const userId = await this.getUserId(ctx);
        if (userId) {
            return `${this.options.prefixKey}|${userId}`;
        }
        return `${this.options.prefixKey}|${ctx.request.ip}`;
    }

    async skip(ctx) { // eslint-disable-line
        if (this.options.skip) {
            return this.options.skip(ctx);
        }
        return false;
    }

    async getUserId(ctx) {
        if (this.options.getUserId) {
            return this.options.getUserId(ctx);
        }
        const whereFinds = [ctx.state.user, ctx.user, ctx.state.User, ctx.User, ctx.state, ctx];
        const toFinds = ['id', 'userId', 'user_id', 'idUser', 'id_user'];
        for (const whereFind of whereFinds) {
            if (whereFind) {
                for (const toFind of toFinds) {
                    if (whereFind[toFind]) {
                        return whereFind[toFind];
                    }
                }
            }
        }
        return null;
    }

    async handler(ctx/*, next*/) {
        if (this.options.handler) {
            return this.options.handler(ctx);
        }
        ctx.status = this.options.statusCode;
        ctx.body = { message: this.options.message };
        if (this.options.headers) {
            ctx.set('Retry-After', Math.ceil(this.options.windowMs / 1000));
        }
    }

    async onLimitReached(ctx) {
        if (this.options.onLimitReached) {
            return this.options.onLimitReached(ctx);
        }
        this.store.saveAbuse(Object.assign(this.options, {
            key: await this.keyGenerator(ctx),
            ip: ctx.request.ip,
            user_id: await this.getUserId(ctx),
        }));
    }

    get middleware() {
        return this._rateLimit.bind(this);
    }

    async _rateLimit(ctx, next) {
        const skip = await this.skip(ctx);
        if (skip) {
            return next();
        }

        const key = await this.keyGenerator(ctx);

        const current = await this.store.incr(key, this.options);
        ctx.state.rateLimit = {
            limit: this.options.max,
            current,
            remaining: Math.max(this.options.max - current, 0),
        };

        if (this.options.headers) {
            ctx.set('X-RateLimit-Limit', this.options.max);
            ctx.set('X-RateLimit-Remaining', ctx.state.rateLimit.remaining);
        }

        if (this.options.max && current > this.options.max) {
            await this.onLimitReached(ctx);
            return this.handler(ctx, next);
        }

        if (this.options.skipFailedRequests) {
            ctx.res.on('finish', () => {
                if (ctx.status >= 400) {
                    this.store.decrement(key, this.options);
                }
            });
        }

        if (this.options.delayAfter && this.options.delayMs && current > this.options.delayAfter) {
            const delay = (current - this.options.delayAfter) * this.options.delayMs;
            await this.sleep(delay);
            return next();
        }
        return next();
    }

    async sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = {
    middleware(options = {}) {
        return new RateLimit(options).middleware;
    },
    defaultOptions(options = {}) {
        defaultOptions = Object.assign(defaultOptions, options);
    },
};
