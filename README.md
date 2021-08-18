# KeywordTracker

These are the build files for the [KeywordTracker](https://github.com/sarahkittyy/KeywordTracker) plugin. Submit PRs here, please ^^

## Cloning

Clone the repo

`git clone --recurse-submodules https://github.com/sarahkittyy/KeywordTrackerSource.git`

If you cloned it without the `--recurse-submodules` flag, you can just initialize the submodules separately:

`git submodule update --init --recursive`

## Building

Edit the source in `plugins/KeywordTracker/`. To compile, run:

`npm run build_plugin KeywordTracker`

This will automatically compile and place the compiled file in `release/KeywordTracker/`, as well as import it into BetterDiscord if it's installed.

## Submitting a PR

Fork this repository, make your changes, and then submit the changes to this repository. I will personally push the changes to the original plugin repository. **Do not submit PRs to the original repository.**
