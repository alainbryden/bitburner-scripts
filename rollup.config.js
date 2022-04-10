import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import pkg from './package.json'

export default [
	// script build
	{
		input: 'helpers.src.js',
		output: {
			name: 'helpers',
			file: 'helpers.js',
			format: 'module',
            banner: '/* THIS FILE IS GENERATED, PLEASE DO NOT EDIT DIRECTLY (Version ' + pkg.version + ') */',
		},
		plugins: [
			resolve(), // so Rollup can find `ms`
			commonjs({ignoreGlobal: true}) 
		]
	},
];