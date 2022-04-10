const gulp = require('gulp');
const rollup = require('rollup');
const clean = require('gulp-clean');

const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');
var pkg = require('./package.json');


gulp.task('clean', () => {
    return gulp.src('dist/**/*')
        .pipe(clean());
});

gulp.task('build', async function () {
    const bundle = await rollup.rollup({
        input: 'helpers.src.js',
        plugins: [
            resolve.nodeResolve(), // so Rollup can find `ms`
            commonjs({ ignoreGlobal: true })
        ]
    });

    await bundle.write({
        file: 'dist/helpers.js',
        banner: '/* THIS FILE IS GENERATED, PLEASE DO NOT EDIT DIRECTLY (Version ' + pkg.version + ') */',
        format: 'module',
        name: 'helpers',
        sourcemap: false
    });

    // copy source files
    gulp.src(["*.js", "!helpers.src.js", "!helpers.js", "!gulpfile.js", "!rollup.config.js"])
        .pipe(gulp.dest("dist/"));
    // copy source files
    gulp.src(["Tasks/**/*", "Remote/**/*", "Flags/**/*"], { "base" : "." })
        .pipe(gulp.dest("dist/"));
});