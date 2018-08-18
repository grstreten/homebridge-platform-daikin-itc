homebridge-platform-smartac
===========================
A [homebridge][1] plug-in for using [Daikin ITC](http://www.daikinac.com/content/commercial/accessories-and-controllers/intelligent-touch-controller-dcs601c71/) air handlers with Siri / HomeKit.

## Installation

1. Ensure that you are running Node.js v7.6 or higher. As of this writing, that means you should be running the [8.x LTS version][4]. If you're unsure what version you've got installed, you can check using: `node --version`
2. Install homebridge using: `npm install -g homebridge`
3. Install this plugin using: `npm install -g homebridge-platform-daikin-itc`
4. Update your configuration file. See `config-sample.json` in this repository for an example.

That's it!

## Configuration

There is zero security on the ITC. Just configure the plugin to point to the correct IP, and you should be good to go. You can provide pretty names for the zones in the config file (see sample).

[1]: https://github.com/nfarina/homebridge
[4]: https://nodejs.org/en/download
