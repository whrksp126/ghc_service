import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({
  endpoint: process.env.OBJECTSTORE_ENDPOINT || 'https://objectstore.ghmate.com',
  region: 'us-east-1',
  credentials: {
    accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY || '',
    secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY || '',
  },
  forcePathStyle: true,
});

const BUCKET = process.env.OBJECTSTORE_BUCKET || 'ghc-dev';

export async function uploadFile(key: string, body: Buffer, contentType: string) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

export async function getPresignedUrl(key: string, expiresIn = 3600) {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}

export async function deleteFile(key: string) {
  await s3.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
}

export { s3, BUCKET };
