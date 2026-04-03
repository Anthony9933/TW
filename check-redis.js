#!/usr/bin/env node
/**
 * Quick Redis connection test - run this to debug
 * Usage: node check-redis.js
 */

require('dotenv').config();

async function testRedis() {
  console.log('🔍 Checking Redis configuration...\n');

  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  const redisUrl = process.env.REDIS_URL;

  console.log('Environment variables:');
  console.log('  UPSTASH_REDIS_REST_URL:', upstashUrl ? '✅ Set' : '❌ Missing');
  console.log('  UPSTASH_REDIS_REST_TOKEN:', upstashToken ? '✅ Set' : '❌ Missing');
  console.log('  KV_REST_API_URL:', process.env.KV_REST_API_URL ? '✅ Set' : '❌ Missing');
  console.log('  KV_REST_API_TOKEN:', process.env.KV_REST_API_TOKEN ? '✅ Set' : '❌ Missing');
  console.log('  REDIS_URL:', redisUrl ? '✅ Set' : '❌ Missing');

  if (redisUrl && redisUrl.startsWith('redis://')) {
    console.log('\n✅ Traditional Redis URL found (Redis Labs/Cloud)');
    console.log('Testing connection...\n');
    await testTraditionalRedis(redisUrl);
  } else if (upstashUrl && upstashToken) {
    console.log('\n✅ Upstash REST API credentials found');
    console.log('Testing connection...\n');
    await testUpstashRedis(upstashUrl, upstashToken);
  } else {
    console.log('\n❌ No Redis configuration found');
    console.log('📝 Options:');
    console.log('  1. Set up Upstash: https://console.upstash.com');
    console.log('  2. Use Vercel Storage → Create Database → Redis');
    return;
  }
}

async function testUpstashRedis(url, token) {
  try {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url, token });

    await redis.set('test:ping', 'pong', { ex: 10 });
    console.log('✅ Write test passed');

    const val = await redis.get('test:ping');
    console.log('✅ Read test passed:', val);

    const totals = await redis.mget(
      'sw:totals:inbound',
      'sw:totals:outbound',
      'sw:totals:errors'
    );
    console.log('\n📊 Current analytics:');
    console.log('  Inbound:', totals[0] || 0);
    console.log('  Outbound:', totals[1] || 0);
    console.log('  Errors:', totals[2] || 0);

    console.log('\n✅ Upstash Redis is working!');
  } catch (err) {
    console.error('\n❌ Upstash connection failed:', err.message);
  }
}

async function testTraditionalRedis(url) {
  try {
    const IORedis = require('ioredis');
    const redis = new IORedis(url);

    await redis.set('test:ping', 'pong', 'EX', 10);
    console.log('✅ Write test passed');

    const val = await redis.get('test:ping');
    console.log('✅ Read test passed:', val);

    const totals = await redis.mget(
      'sw:totals:inbound',
      'sw:totals:outbound',
      'sw:totals:errors'
    );
    console.log('\n📊 Current analytics:');
    console.log('  Inbound:', totals[0] || 0);
    console.log('  Outbound:', totals[1] || 0);
    console.log('  Errors:', totals[2] || 0);

    console.log('\n✅ Traditional Redis is working!');
    await redis.quit();
  } catch (err) {
    console.error('\n❌ Traditional Redis connection failed:', err.message);
  }
}

testRedis();
