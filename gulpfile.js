const gulp = require('gulp');
const rollup = require('rollup');
const del = require('del');

const resolve = require('@rollup/plugin-node-resolve');
const commonjs = require('@rollup/plugin-commonjs');


gulp.task('clean', function () {
    return del('dist/**', {force:true});
});

gulp.task('do-build', async function () {
    const bundle = await rollup.rollup({
        input: 'helpers.src.js',
        plugins: [
            resolve.nodeResolve(), // so Rollup can find `ms`
            commonjs({ ignoreGlobal: true })
        ]
    });

    await bundle.write({
        file: 'dist/helpers.js',
        banner: '/* THIS FILE IS GENERATED, PLEASE DO NOT EDIT DIRECTLY */',
        format: 'module',
        name: 'helpers',
        sourcemap: false
    });

    await bundle.write({
        file: 'helpers.js',
        banner: '/* THIS FILE IS GENERATED, PLEASE DO NOT EDIT DIRECTLY */',
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

gulp.task('build', gulp.series('clean', 'do-build'));
