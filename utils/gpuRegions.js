/**
 * The AWS regions our GPU training server may run in, in the order the dispatcher tries them,
 * with the g4dn.xlarge on-demand price (AWS price list, Nov 2026). Used by the superadmin GPU tab.
 */
const USD_TO_INR = 88;

const GPU_REGIONS = {
  'ap-south-1': { name: 'Mumbai', country: 'India', usdPerHour: 0.579 },
  'us-east-2': { name: 'US East (Ohio)', country: 'USA', usdPerHour: 0.526 },
  'eu-west-1': { name: 'Ireland', country: 'Ireland', usdPerHour: 0.587 },
};

/** Regions the hourly availability check looks at (only ones that offer g4dn) */
const TRACKED_REGIONS = {
  'ap-south-1': 'Mumbai',
  'us-east-1': 'US East (Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-2': 'US West (Oregon)',
  'ca-central-1': 'Canada',
  'eu-west-1': 'Ireland',
  'eu-west-2': 'London',
  'eu-west-3': 'Paris',
  'eu-central-1': 'Frankfurt',
  'eu-north-1': 'Stockholm',
  'ap-southeast-1': 'Singapore',
  'ap-northeast-1': 'Tokyo',
  'ap-northeast-3': 'Osaka',
  'ap-northeast-2': 'Seoul',
  'ap-southeast-2': 'Sydney',
  'sa-east-1': 'São Paulo',
};

function regionName(region) {
  return GPU_REGIONS[region]?.name || TRACKED_REGIONS[region] || region || 'Unknown';
}

/** Rupees an hour for a region; Mumbai's price when the region isn't known (older records) */
function inrPerHour(region) {
  const usd = (GPU_REGIONS[region] || GPU_REGIONS['ap-south-1']).usdPerHour;
  return Math.round(usd * USD_TO_INR);
}

module.exports = { USD_TO_INR, GPU_REGIONS, TRACKED_REGIONS, regionName, inrPerHour };
