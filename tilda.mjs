#!/usr/bin/env node
import { launch } from './plugins/tilda-connect/scripts/launch.mjs';
await launch(process.argv.slice(2));
