'use strict';

var chai = require('chai');
var expect = chai.expect;

var Firewalla = require('../net2/Firewalla.js');
var f = new Firewalla("config.json", 'info');

expect(f.getFirewallaHome()).to.equal(process.env.HOME + "/firewalla");

setTimeout(function() {
    process.exit();
},3000);
