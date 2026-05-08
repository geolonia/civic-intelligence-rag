import { get as httpsGet } from 'node:https';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Pool } from 'pg';

interface DbSecret {
  username: string;
  password: string;
  host: string;
  port: number;
  dbname: string;
}

const RDS_GLOBAL_BUNDLE_URL = 'https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem';
let cachedCert: string | undefined;
let cachedPool: Pool | undefined;

function fetchRdsCaCert(): Promise<string> {
  return new Promise((resolve, reject) => {
    httpsGet(RDS_GLOBAL_BUNDLE_URL, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

export async function getDbPool(): Promise<Pool> {
  if (cachedPool) return cachedPool;
  if (!cachedCert) cachedCert = await fetchRdsCaCert();
  const sm = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const resp = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN! }));
  const secret = JSON.parse(resp.SecretString!) as DbSecret;
  cachedPool = new Pool({
    host: secret.host,
    port: secret.port,
    database: process.env.DB_NAME || 'lawsy',
    user: secret.username,
    password: secret.password,
    ssl: { ca: cachedCert, rejectUnauthorized: true },
    max: 3,
  });
  return cachedPool;
}
