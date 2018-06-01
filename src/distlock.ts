import 'source-map-support/register'
import Promise = require('bluebird');
import redis = require('redis-bluebird');
import uuid = require('uuid');
import fs = require('fs');

export class DistLock implements Lock {

  private id: string;
  private static script: string;
  private locked: boolean;

  constructor(private redisClient: redis.RedisClient,
              private key: string) {
    if (!DistLock.script) {
      DistLock.script = fs.readFileSync(__dirname + '/../lua/unlock.lua', {encoding: 'utf8'});
    }
  }

  public lock(option?: LockOption) {
    if (this.locked) {
      return Promise.reject<DistLock>(new Error('lock: duplicated'));
    }
    this.locked = true;
    this.id = uuid.v4();
    option = option || {};

    const deferred = Promise.defer<DistLock>();
    let retry = 0;
    const tryLock = () => {
      this.redisClient.set(this.key, this.id, 'PX', option.ttl || 15000, 'NX', (err, locked) => {
        if (err) return deferred.reject(err);
        if (locked) {
          return deferred.resolve(this);
        } else {
          if (++retry > (option.retryLimit || 100)) {
            return deferred.reject(new Error('lock: exceeds retry count'));
          }
          setTimeout(tryLock, option.retryDelay || 100);
        }
      });
    };
    tryLock();
    return deferred.promise;
  }

  public unlock() {
    return new Promise((resolve, reject) => {
      this.redisClient.evalAsync(DistLock.script, 1, this.key, this.id)
        .then(result => {
          this.locked = false;
          return resolve(result);
        })
        .catch(err => {
          return reject(err);
        });
    });
  }
}

export interface LockOption {
  ttl?: number;
  retryLimit?: number;
  retryDelay?: number;
}

export interface Lock {
  lock: (option?: LockOption) => Promise<Lock>;
  unlock: () => Promise<any>;
}
