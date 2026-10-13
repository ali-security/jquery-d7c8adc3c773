/* jshint node: true, browser: false, es3: false */
/* global Promise: false */

// Headless runner for the QUnit suite (test/index.html), used on Travis CI.
// Usage: CHROME_BIN=<chrome> NODE_PATH=<dir with puppeteer-core> node test/run-headless.js [url]
// Hooks QUnit.log/testStart/testDone/done, prints every test result, every failed
// assertion and a per-module and overall summary, and exits non-zero on any
// failure, on a stalled test queue, or on the overall timeout.

var puppeteer = require( "puppeteer-core" ),
	pageUrl = process.argv[ 2 ] || "http://localhost:8000/test/index.html",
	timeoutMs = parseInt( process.env.QUNIT_TIMEOUT_MS || "1800000", 10 ),

	// QUnit's own per-test timeout is 20s (test/data/testrunner.js), so a test that
	// reports nothing for this long means the queue itself is dead
	stallMs = parseInt( process.env.QUNIT_STALL_MS || "90000", 10 ),
	modules = {},
	moduleOrder = [],
	testCount = 0,
	failedTests = [],
	currentTest = "(suite not started)",
	lastProgress = Date.now(),
	finished = false,
	browser;

function hookQUnit() {
	var value;

	// Only the top window owns the suite; iframes use parent.QUnit
	if ( window.top !== window ) {
		return;
	}
	Object.defineProperty( window, "QUnit", {
		configurable: true,
		get: function() {
			return value;
		},
		set: function( QUnit ) {
			var assertions = [],
				start = QUnit.start;
			value = QUnit;

			// QUnit 1.14 also calls QUnit.load on window "load", which rebuilds the
			// #qunit DOM. test/data/testinit.js starts the suite as soon as the test
			// modules are loaded, so if the window "load" event comes later (slow
			// subresource, e.g. data/iframe.html), the rebuild deletes the running
			// test's result element and QUnit's queue dies ("Cannot set properties of
			// null (setting 'className')"). Hold the suite start until "load" has fired.
			QUnit.start = function() {
				var self = this,
					args = arguments;
				if ( document.readyState === "complete" ) {
					return start.apply( self, args );
				}
				window.__qunitReport( "waiting", {} );
				window.addEventListener( "load", function() {
					setTimeout( function() {
						start.apply( self, args );
					}, 0 );
				});
			};
			QUnit.log(function( details ) {
				if ( !details.result ) {
					assertions.push({
						message: String( details.message || "" ),
						actual: QUnit.jsDump.parse( details.actual ),
						expected: QUnit.jsDump.parse( details.expected ),
						source: details.source ? String( details.source ).split( "\n" )[ 0 ] : ""
					});
				}
			});
			QUnit.testStart(function( details ) {
				window.__qunitReport( "testStart", { module: details.module, name: details.name } );
			});
			QUnit.testDone(function( details ) {
				window.__qunitReport( "testDone", {
					module: details.module,
					name: details.name,
					failed: details.failed,
					passed: details.passed,
					total: details.total,
					assertions: assertions
				});
				assertions = [];
			});
			QUnit.done(function( details ) {
				window.__qunitReport( "done", details );
			});
		}
	});
}

function finish( code ) {
	var closing;
	if ( finished ) {
		return;
	}
	finished = true;
	closing = browser ? browser.close() : Promise.resolve();
	closing.then( function() {
		process.exit( code );
	}, function() {
		process.exit( code );
	});
}

function onTestDone( t ) {
	var m = modules[ t.module ];
	if ( !m ) {
		m = modules[ t.module ] = { tests: 0, failedTests: 0, total: 0, passed: 0, failed: 0 };
		moduleOrder.push( t.module );
	}
	testCount++;
	m.tests++;
	m.total += t.total;
	m.passed += t.passed;
	m.failed += t.failed;
	if ( t.failed ) {
		m.failedTests++;
		failedTests.push( t.module + ": " + t.name );
		console.log( "not ok " + testCount + " - " + t.module + ": " + t.name +
			" (" + t.failed + " of " + t.total + " assertions failed)" );
		t.assertions.forEach( function( a ) {
			console.log( "    # " + a.message );
			console.log( "    #   expected: " + a.expected );
			console.log( "    #   actual:   " + a.actual );
			if ( a.source ) {
				console.log( "    #   " + a.source.trim() );
			}
		});
	} else {
		console.log( "ok " + testCount + " - " + t.module + ": " + t.name +
			" (" + t.passed + " assertions)" );
	}
}

function printSummary( completedLine ) {
	var total = 0, passed = 0, failed = 0;
	console.log( "" );
	console.log( "Per-module results:" );
	moduleOrder.forEach( function( name ) {
		var m = modules[ name ];
		total += m.total;
		passed += m.passed;
		failed += m.failed;
		console.log( "  " + name + ": " + m.tests + " tests (" + m.failedTests + " failed), " +
			m.total + " assertions, " + m.passed + " passed, " + m.failed + " failed" );
	});
	console.log( "" );
	if ( failedTests.length ) {
		console.log( "Failed tests:" );
		failedTests.forEach( function( name ) {
			console.log( "  " + name );
		});
	}
	console.log( completedLine + ": " + testCount + " tests, " +
		total + " assertions, " + passed + " passed, " + failed + " failed." );
	return failed;
}

function onDone( d ) {
	var failed = printSummary( "Tests completed in " + d.runtime + " ms" );
	finish( failed || d.failed || failedTests.length || !d.total ? 1 : 0 );
}

function abort( reason ) {
	console.log( "ABORTED: " + reason );
	console.log( "Test in progress: " + currentTest );
	printSummary( "Suite ABORTED (did not complete), results so far" );
	finish( 2 );
}

// Watchdog: heartbeat while a test runs, abort when the queue stalls
setInterval( function() {
	var idle = Date.now() - lastProgress;
	if ( finished ) {
		return;
	}
	if ( idle >= stallMs ) {
		abort( "no test finished for " + Math.round( idle / 1000 ) + "s" );
	} else if ( idle >= 15000 ) {
		console.log( "  ... still running " + currentTest + " (" + Math.round( idle / 1000 ) + "s)" );
	}
}, 15000 );

setTimeout( function() {
	abort( "overall timeout of " + timeoutMs + " ms reached" );
}, timeoutMs );

puppeteer.launch({
	executablePath: process.env.CHROME_BIN,
	headless: "new",
	args: [ "--no-sandbox", "--disable-dev-shm-usage" ]
}).then( function( b ) {
	browser = b;
	return browser.newPage();
}).then( function( page ) {
	page.on( "pageerror", function( err ) {
		console.log( "[page error during " + currentTest + "] " + err.message );
	});
	return browser.version().then( function( version ) {
		console.log( "Running " + pageUrl + " in " + version );
		return page.exposeFunction( "__qunitReport", function( type, data ) {
			lastProgress = Date.now();
			if ( type === "waiting" ) {
				console.log( "Test modules loaded; waiting for the window load event before starting" );
			} else if ( type === "testStart" ) {
				currentTest = data.module + ": " + data.name;
			} else if ( type === "testDone" ) {
				onTestDone( data );
			} else {
				onDone( data );
			}
		});
	}).then( function() {
		return page.evaluateOnNewDocument( hookQUnit );
	}).then( function() {
		// Focus/blur tests in event.js need the page to own focus
		return page.bringToFront();
	}).then( function() {
		return page.goto( pageUrl );
	});
}).catch( function( err ) {
	console.log( "Runner error: " + ( err && err.stack || err ) );
	finish( 3 );
});
