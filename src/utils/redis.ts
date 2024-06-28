import {Redis} from "ioredis";
import dotenv from "dotenv";
dotenv.config();

const redis = new Redis({
    host: process.env.REDIS_HOST,
    port: 12881,
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

redis.on('error', error => {
    console.error('Error connecting to Redis Session Store:');
});
  
  redis.on('reconnecting', () => {
    if (redis.status === 'reconnecting')
      console.log('Reconnecting to Redis Session Store...');
    else console.log('Error reconnecting to Redis Session Store.');
  });
  
  redis.on('connect', (err: any) => {
    if (!err) console.log('Connected to Redis Session Store!');
  });

export {redis};