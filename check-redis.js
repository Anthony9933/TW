#!/usr/bin/env node
/**
 * Quick Redis connection test - run this to debug
 * Usage: node check-redis.js
 */

require('dotenv').config();

async function testRedis() {
  console.log('🔍 Checking Redis configuration...\n');

  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  console.log('Environment variables:');
  console.log('  UPSTASH_REDIS_REST_URL:', url ? '✅ Set' : '❌ Missing');
  console.log('  UPSTASH_REDIS_REST_TOKEN:', token ? '✅ Set' : '❌ Missing');
  console.log('  KV_REST_API_URL:', process.env.KV_REST_API_URL ? '✅ Set' : '❌ Missing');
  console.log('  KV_REST_API_TOKEN:', process.env.KV_REST_API_TOKEN ? '✅ Set' : '❌ Missing');

  if (!url || !token) {
    console.log('\n❌ Redis not configured');
    console.log('📝 Set up Redis in Vercel: Project → Storage → Create Database → Redis');
    return;
  }

  console.log('\n✅ Redis credentials found');
  console.log('Testing connection...\n');

  try {
    const { Redis } = require('@upstash/redis');
    const redis = new Redis({ url, token });

    // Test write
    await redis.set('test:ping', 'pong', { ex: 10 });
    console.log('✅ Write test passed');

    // Test read
    const val = await redis.get('test:ping');
    console.log('✅ Read test passed:', val);

    // Check analytics keys
    const totals = await redis.mget(
      'sw:totals:inbound',
      'sw:totals:outbound',
      'sw:totals:errors'
    );
    console.log('\n📊 Current analytics:');
    console.log('  Inbound:', totals[0] || 0);
    console.log('  Outbound:', totals[1] || 0);
    console.log('  Errors:', totals[2] || 0);

    console.log('\n✅ Redis is working!');
  } catch (err) {
    console.error('\n❌ Redis connection failed:', err.message);
  }
}

testRedis();
