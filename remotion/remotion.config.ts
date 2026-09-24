import { Config } from "@remotion/cli/config";

Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
// Quality suited to phone playback without producing enormous files.
Config.setCrf(20);
