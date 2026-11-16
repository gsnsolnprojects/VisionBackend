#!/bin/bash
# Start a GPU training server when a training is waiting in the queue (it switches itself off when idle).
# First the usual one in Mumbai zone 1c. If AWS has no GPU free there, a copy of it (AMI) is made in
# 1a, then 1b, then in each fallback region abroad (REMOTE below), always the same GPU type. A copy
# deletes itself when it switches off (shutdown = terminate), and any copy found stopped is deleted here.
# Never more than one GPU server at a time; never on the CPU.
# While AWS has no GPU to give anywhere, the marker file tells the app, so the student sees why.
# Every attempt is written to gpu-tracking/dispatch.jsonl for the superadmin GPU tab.
# Installed on the main server as /usr/local/bin/vision-gpu-dispatch.sh (timer: every 2 minutes).
set -u
REGION=ap-south-1
GPU=i-0a1c9067cb00cf5b5
AMI=ami-053645d8c5e14ca0d
TYPE=g4dn.xlarge
SG=sg-017f86bf7c0afd2b4
PROFILE=vision-api-ec2
ROOT_DEVICE=/dev/xvda
SUBNETS="subnet-0302b6f0631e3ea43:ap-south-1a subnet-08df76b64edb7d0ea:ap-south-1b" # subnet:zone
# Fallback regions abroad, tried in this order: "region ami security-group subnet:zone subnet:zone ..."
# (each needs a copy of the AMI, a VPC peered with Mumbai, and the G-instance quota)
REMOTE=(
  "us-east-2 ami-0ba55e60c8327513a sg-0da085a9552d8e01f subnet-0c9999b390b009f52:us-east-2a subnet-0a346f10a36e3d824:us-east-2b subnet-0b5586265edd20d10:us-east-2c"
  "eu-west-1 ami-0ac3319288c349f9c sg-0a4fefc3eb97bd9d5 subnet-02ad83adc0ada1af4:eu-west-1a subnet-0f8da818579979332:eu-west-1b subnet-0b7b7bae3b5caa159:eu-west-1c"
)
NO_GPU=/srv/vision/data/.gpu-no-capacity
LOG_DIR=/srv/vision/data/gpu-tracking
LOG=$LOG_DIR/dispatch.jsonl
mkdir -p "$LOG_DIR"

# One line per attempt: when, where, and what AWS said
log() { # region zone result instance message
  local msg=${5//\\/\\\\}; msg=${msg//\"/\\\"}; msg=$(printf '%s' "$msg" | tr '\n\r\t' '   ' | cut -c1-300)
  printf '{"at":"%s","region":"%s","zone":"%s","result":"%s","instanceId":"%s","waiting":%s,"message":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "$4" "${n:-0}" "$msg" >> "$LOG"
}
# What AWS said, in one short line
reason() { case "$1" in *InsufficientInstanceCapacity*) echo full ;; *) echo error ;; esac; }

# Copies that switched off but weren't deleted (e.g. stopped by hand): their disk would cost money
cleanup() { # region
  for id in $(aws ec2 --region "$1" describe-instances \
    --filters Name=tag:Name,Values=vision-gpu-trainer Name=tag:Copy,Values=yes Name=instance-state-name,Values=stopped \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null); do
    aws ec2 --region "$1" terminate-instances --instance-ids "$id" >/dev/null && echo "deleted stopped copy $id in $1"
  done
}
# GPU servers starting, running or switching off in a region
busy_in() { # region
  aws ec2 --region "$1" describe-instances \
    --filters Name=tag:Name,Values=vision-gpu-trainer Name=instance-state-name,Values=pending,running,stopping,shutting-down \
    --query 'length(Reservations[].Instances[])' --output text 2>/dev/null
}
# Start a copy from the AMI in one subnet; prints the instance id, or AWS's error
launch_copy() { # region ami sg subnet
  aws ec2 --region "$1" run-instances --image-id "$2" --instance-type "$TYPE" --subnet-id "$4" \
    --security-group-ids "$3" --iam-instance-profile Name="$PROFILE" \
    --instance-initiated-shutdown-behavior terminate \
    --metadata-options HttpTokens=required,HttpPutResponseHopLimit=2,HttpEndpoint=enabled \
    --block-device-mappings "[{\"DeviceName\":\"$ROOT_DEVICE\",\"Ebs\":{\"DeleteOnTermination\":true}}]" \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=vision-gpu-trainer},{Key=Copy,Value=yes}]' \
      'ResourceType=volume,Tags=[{Key=Name,Value=vision-gpu-trainer-copy}]' \
    --query 'Instances[0].InstanceId' --output text 2>&1
}

cleanup "$REGION"
for entry in "${REMOTE[@]}"; do set -- $entry; cleanup "$1"; done

n=$(docker exec vision-redis-1 redis-cli LLEN bull:train-model:wait 2>/dev/null)
if [ "${n:-0}" -le 0 ]; then rm -f "$NO_GPU"; exit 0; fi

# One GPU server at a time: one already starting, running or switching off (anywhere) takes the queue
busy=$(busy_in "$REGION") || exit 0
if [ "${busy:-0}" != "0" ]; then rm -f "$NO_GPU"; exit 0; fi
for entry in "${REMOTE[@]}"; do
  set -- $entry
  b=$(busy_in "$1") || exit 0
  if [ "${b:-0}" != "0" ]; then rm -f "$NO_GPU"; exit 0; fi
done

if err=$(aws ec2 --region "$REGION" start-instances --instance-ids "$GPU" 2>&1 >/dev/null); then
  rm -f "$NO_GPU"
  log "$REGION" ap-south-1c started "$GPU" ""
  echo "started GPU (1c) for $n waiting training(s)"
  exit 0
fi
echo "1c: $err"
log "$REGION" ap-south-1c "$(reason "$err")" "" "$err"
case "$err" in *InsufficientInstanceCapacity*) ;; *) exit 1 ;; esac

# Any failure below (no capacity, or a missing permission) moves on to the next place
for pair in $SUBNETS; do
  subnet=${pair%%:*} zone=${pair#*:}
  if out=$(launch_copy "$REGION" "$AMI" "$SG" "$subnet"); then
    rm -f "$NO_GPU"
    log "$REGION" "$zone" started "$out" ""
    echo "1c full: started copy $out in $zone for $n waiting training(s)"
    exit 0
  fi
  log "$REGION" "$zone" "$(reason "$out")" "" "$out"
  echo "$zone: $out"
done

for entry in "${REMOTE[@]}"; do
  set -- $entry
  r=$1 ami=$2 sg=$3; shift 3
  for pair in "$@"; do
    subnet=${pair%%:*} zone=${pair#*:}
    if out=$(launch_copy "$r" "$ami" "$sg" "$subnet"); then
      rm -f "$NO_GPU"
      log "$r" "$zone" started "$out" ""
      echo "Mumbai full: started copy $out in $zone for $n waiting training(s)"
      exit 0
    fi
    log "$r" "$zone" "$(reason "$out")" "" "$out"
    echo "$zone: $out"
  done
done

touch "$NO_GPU"
exit 1
