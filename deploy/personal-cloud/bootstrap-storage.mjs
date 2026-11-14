import { readFile } from 'node:fs/promises';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
const endpoint = process.env.AITESTHUB_S3_ENDPOINT,
  bucket = process.env.AITESTHUB_S3_BUCKET;
if (
  endpoint !== 'http://seaweedfs:8333' ||
  !/^aitesthub-personal-[a-f0-9]{12}$/.test(bucket ?? '')
)
  throw new Error('Expected the independently prepared private cloud bucket');
const client = new S3Client({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  maxAttempts: 1,
  credentials: {
    accessKeyId: (
      await readFile('/run/secrets/s3_bootstrap_access', 'utf8')
    ).trim(),
    secretAccessKey: (
      await readFile('/run/secrets/s3_bootstrap_secret', 'utf8')
    ).trim(),
  },
});
try {
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log('Cloud bucket already exists; no write repeated.');
  } catch (error) {
    if (error?.$metadata?.httpStatusCode !== 404)
      throw new Error('Bucket lookup unavailable; no create was attempted.');
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      console.log('Independent cloud bucket created.');
    } catch {
      throw new Error(
        'Bucket creation receipt uncertain; read the original bucket before any new write.',
      );
    }
  }
} finally {
  client.destroy();
}
