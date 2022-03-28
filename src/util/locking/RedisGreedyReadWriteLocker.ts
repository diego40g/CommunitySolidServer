import { createClient, RedisClient } from "redis";
import Redlock, { Settings } from "redlock";
import { ResourceIdentifier } from "../../http/representation/ResourceIdentifier";
import { InternalServerError } from "../errors/InternalServerError";
import { ReadWriteLocker } from "./ReadWriteLocker";
import Redis, { Cluster } from 'ioredis';
import { prototype } from "events";

interface GreedyReadWriteSuffixes {
    count: string;
    read: string;
    write: string;
}

const lockTimeout = 3000;

const defaultRedlockConfig: Settings = {
    // The expected clock drift; for more details see:
    // http://redis.io/topics/distlock
    driftFactor: 0.01, // multiplied by lock ttl to determine drift time

    // The max number of times Redlock will attempt to lock a resource
    // before erroring.
    retryCount: 10,

    // the time in ms between attempts
    retryDelay: 200, // time in ms

    // the max time in ms randomly added to retries
    // to improve performance under high contention
    // see https://www.awsarchitectureblog.com/2015/03/backoff.html
    retryJitter: 200, // time in ms

    // The minimum remaining time on a lock before an extension is automatically
    // attempted with the `using` API.
    automaticExtensionThreshold: 500, // time in ms
};

// Define script constants.
const TRY_READ = `
  -- Return 0 if an entry already exists.
  if redis.call("exists", KEYS[0]..".lock") == 1 then
    return 0
  end
  
  -- Increase count
  return redis.call("incr", KEYS[0]..".count")
`;

const TRY_WRITE = `
  -- Return 0 if an entry already exists.
  if (redis.call("exists", KEYS[0]..".lock") == 1) or (redis.call("get", KEYS[0]..".count" > 0)) then
    return 0
  end
  
  -- Increase count
  return redis.call("set", KEYS[0]..".lock")
`;

const suffixes: GreedyReadWriteSuffixes = { count: 'count', read: 'read', write: 'write' };

export class RedisGreedyReadWriteLocker implements ReadWriteLocker {

    private readonly redlock: Redlock;
    private readonly redis: Cluster;

    public constructor(redisClients: string[], redlockOptions?: Partial<Settings>) {
        const parsed = this.parseRedisClients(redisClients);
        const clients = parsed.map(obj => createClient(obj.port, obj.host));
        if (clients.length === 0) {
            throw new Error('At least 1 redis client should be provided');
        }
        
        this.redis = new Redis.Cluster(parsed);
        this.redlock = this.createRedlock(clients, redlockOptions);

        this.redis.defineCommand('tryRead', {
            numberOfKeys: 1,
            lua: TRY_READ
        });
    }

    /**
     * Generate and return a list of RedisClients based on the provided strings
     * @param redisClientsStrings - a list of strings that contain either a host address and a
     * port number like '127.0.0.1:6379' or just a port number like '6379'
     */
    private parseRedisClients(redisClientsStrings: string[]): {host: string, port :number}[] {
        const result: {host: string, port :number}[] = [];
        if (redisClientsStrings && redisClientsStrings.length > 0) {
            for (const client of redisClientsStrings) {
                // Check if port number or ip with port number
                // Definitely not perfect, but configuring this is only for experienced users
                const match = new RegExp(/^(?:([^:]+):)?(\d{4,5})$/u, 'u').exec(client);
                if (!match || !match[2]) {
                    // At least a port number should be provided
                    throw new Error(`Invalid data provided to create a Redis client: ${client}\n
            Please provide a port number like '6379' or a host address and a port number like '127.0.0.1:6379'`);
                }
                const port = Number(match[2]);
                const host = match[1];
                // const redisclient = createClient(port, host);
                result.push({port, host});
            }
        }
        return result;
    }

    /**
     * Generate and return a Redlock instance
     * @param clients - a list of RedisClients you want to use for the redlock instance
     * @param redlockOptions - extra redlock options to overwrite the default config
     */
    private createRedlock(clients: RedisClient[], redlockOptions: Partial<Settings> = {}): Redlock {
        try {
            return new Redlock(
                clients,
                { ...defaultRedlockConfig, ...redlockOptions },
            );
        } catch (error: unknown) {
            throw new InternalServerError(`Error initializing Redlock: ${error}`, { cause: error });
        }
    }

    public async withReadLock<T>(identifier: ResourceIdentifier, whileLocked: () => (Promise<T> | T)): Promise<T> {
        // [
        // if (lock NOT exists)
        //    counter ++
        // ]
        
        
        //    whileLocked();
        //    counter--
        // else 
        //    retry

    }

    public async withWriteLock<T>(identifier: ResourceIdentifier, whileLocked: () => (Promise<T> | T)): Promise<T> {
        // [
        //    if (count === 0 AND lock free)
        //        grab lock
        // ]
        //        whileLocked();
        //        release lock();
        //    else
        //        retry
        
    }

    /**
      * This key is used for storing the count of active read operations.
      */
    private getCountKey(identifier: ResourceIdentifier): string {
        return `${identifier.path}.${suffixes.count}`;
    }

    /**
     * This is the identifier for the read lock: the lock that is used to safely update and read the count.
     */
    private getReadLockKey(identifier: ResourceIdentifier): string {
        return `${identifier.path}.${suffixes.read}`;
    }

    /**
     * This is the identifier for the write lock, making sure there is at most 1 write operation active.
     */
    private getWriteLockKey(identifier: ResourceIdentifier): string {
        return `${identifier.path}.${suffixes.write}`;
    }
}