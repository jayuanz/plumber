import crypto from 'node:crypto';

const issuer = process.env.TOTP_ISSUER || 'Plumber';
const account = process.env.TOTP_ACCOUNT || process.env.WEBTERM_USERNAME || 'admin';
const bytes = Number.parseInt(process.env.TOTP_SECRET_BYTES || '20', 10);

if (!Number.isInteger(bytes) || bytes < 16) {
  console.error('TOTP_SECRET_BYTES must be at least 16.');
  process.exit(1);
}

const secret = toBase32(crypto.randomBytes(bytes));
const label = `${issuer}:${account}`;
const uri = new URL(`otpauth://totp/${encodeURIComponent(label)}`);
uri.searchParams.set('secret', secret);
uri.searchParams.set('issuer', issuer);
uri.searchParams.set('algorithm', 'SHA1');
uri.searchParams.set('digits', '6');
uri.searchParams.set('period', '30');

console.log('Add this secret to your authenticator app:');
console.log(secret);
console.log('');
console.log('Or import this otpauth URI:');
console.log(uri.toString());
console.log('');
console.log('Recommended .env settings:');
console.log('WEBTERM_AUTH_MODE=password_totp');
console.log(`WEBTERM_TOTP_SECRET_BASE32=${secret}`);

function toBase32(buffer) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, '0');
  }

  let output = '';
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, '0');
    output += alphabet[Number.parseInt(chunk, 2)];
  }

  return output;
}
