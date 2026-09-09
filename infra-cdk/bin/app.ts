#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsopsStack } from '../lib/awsops-stack';

const app = new cdk.App();
cdk.Tags.of(app).add('Project', 'awsops');

// Vpc.fromLookup needs a concrete account/region
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-2',
};

new AwsopsStack(app, 'AwsopsStack', {
  env,
  description: 'AWSops Dashboard - single EC2 in a private subnet, reached via SSM port forwarding',
});

app.synth();
