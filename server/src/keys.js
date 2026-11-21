import crypto from 'node:crypto';
import { generateVapidKeys } from './crypto.js';

const v = generateVapidKeys();
console.log('# Paste these into server/.env (keep them secret, never commit them)');
console.log(`MASTER_KEY=${crypto.randomBytes(32).toString('hex')}`);
console.log(`VAPID_PUBLIC_KEY=${v.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${v.privateKey}`);
