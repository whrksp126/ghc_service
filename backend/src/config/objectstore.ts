import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/client-s3';
import type { Command } from '@smithy/types';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// 홈서버는 정전/재부팅 직후 시계가 잠깐 틀어진다(RTC 미교정). @aws-sdk/client-s3 는 처음
// skew 를 만나면 clock offset 을 클라이언트에 캐시하는데, 시계가 정상 복구돼도 그 낡은
// 오프셋 때문에 프로세스 재시작 전까지 서명이 계속 실패한다(RequestTimeTooSkewed).
// → 싱글턴을 재사용하되 skew 에러 감지 시 클라이언트를 재생성(오프셋 리셋)하고 재시도한다.
function buildClient(): S3Client {
  return new S3Client({
    endpoint: process.env.OBJECTSTORE_ENDPOINT || 'https://objectstore.ghmate.com',
    region: 'us-east-1',
    credentials: {
      accessKeyId: process.env.OBJECTSTORE_ACCESS_KEY || '',
      secretAccessKey: process.env.OBJECTSTORE_SECRET_KEY || '',
    },
    forcePathStyle: true,
  });
}

let s3 = buildClient();

const BUCKET = process.env.OBJECTSTORE_BUCKET || 'ghc-dev';

// 시계 오차로 인한 서명 실패인지 판별. AWS SDK v3 는 err.name === 'RequestTimeTooSkewed'.
function isClockSkewError(err: unknown): boolean {
  const e = err as { name?: string; Code?: string; message?: string } | undefined;
  const hay = `${e?.name || ''} ${e?.Code || ''} ${e?.message || ''}`;
  return /RequestTimeTooSkewed|clock skew|too large|too skewed/i.test(hay);
}

// 모든 s3.send 호출은 이 래퍼를 통과시켜, skew 에러 시 클라이언트를 재생성 후 1회 재시도한다.
export async function sendWithRetry<
  InputType extends ServiceInputTypes,
  OutputType extends ServiceOutputTypes,
>(
  command: Command<ServiceInputTypes, InputType, ServiceOutputTypes, OutputType, any>,
): Promise<OutputType> {
  try {
    return await s3.send(command);
  } catch (err) {
    if (isClockSkewError(err)) {
      // 낡은 clock offset 캐시를 버리고 새 클라이언트로 재시도(시계 복구 시 무재시작 자동회복).
      console.warn('[objectstore] clock skew detected, rebuilding S3 client and retrying');
      s3 = buildClient();
      return await s3.send(command);
    }
    throw err;
  }
}

export async function uploadFile(key: string, body: Buffer, contentType: string) {
  await sendWithRetry(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return key;
}

export async function getPresignedUrl(key: string, expiresIn = 3600) {
  // presign 은 로컬 서명 연산이라 네트워크 skew 에러를 던지지 않지만, 재생성된 최신
  // 클라이언트(=리셋된 offset)를 쓰도록 항상 모듈 수준 s3 를 참조한다.
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn }
  );
}

export async function deleteFile(key: string) {
  await sendWithRetry(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key: key,
  }));
}

export { s3, BUCKET };
