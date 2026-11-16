/**
 * Where this GPU server is running, from the EC2 instance metadata service (IMDSv2):
 * region, zone, machine type and instance id. Only answers on an EC2 machine; anywhere else
 * (a laptop, the CPU worker) it gives null after a short timeout.
 */
const IMDS = 'http://169.254.169.254/latest';
const TIMEOUT_MS = 2000;

let cached;

async function imds(pathname, token) {
  const res = await fetch(`${IMDS}/${pathname}`, {
    headers: { 'X-aws-ec2-metadata-token': token },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`IMDS ${pathname}: ${res.status}`);
  return (await res.text()).trim();
}

async function getGpuPlacement() {
  if (cached !== undefined) return cached;
  try {
    const tokenRes = await fetch(`${IMDS}/api/token`, {
      method: 'PUT',
      headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '300' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!tokenRes.ok) throw new Error(`IMDS token: ${tokenRes.status}`);
    const token = await tokenRes.text();
    const [zone, region, instanceType, instanceId] = await Promise.all([
      imds('meta-data/placement/availability-zone', token),
      imds('meta-data/placement/region', token),
      imds('meta-data/instance-type', token),
      imds('meta-data/instance-id', token),
    ]);
    cached = { region, zone, instanceType, instanceId };
  } catch (error) {
    console.warn('[GPU-PLACEMENT] not on EC2 or metadata unavailable:', error.message);
    cached = null;
  }
  return cached;
}

module.exports = { getGpuPlacement };
