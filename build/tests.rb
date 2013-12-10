TESTS = FileList["tests/**/*"]
GRUNT = "./node_modules/.bin/grunt"
XVFB_RUN = "xvfb-run"
GRUNT_CMD = system("which", XVFB_RUN, :out => "/dev/null") ? [XVFB_RUN, "-a", GRUNT] : [GRUNT]
DEPS = [MIN_JS, MIN_CSS, KENDO_CONFIG_FILE, TESTS].flatten

namespace :tests do
    task :java do
        mvn(POM, 'clean test')
    end

    task :aspnetmvc do
        msbuild "wrappers/mvc/Kendo.Mvc.sln"
        sh "build/xunit/xunit.console.clr4.exe wrappers/mvc/tests/Kendo.Mvc.Tests/bin/Release/Kendo.Mvc.Tests.dll"
    end

    desc "Run tests in firefox"
    task :firefox => DEPS do
        sh *(GRUNT_CMD + [ "karma", "--junit-results=firefox-test-results.xml", "--single-run=true", "--browser=Firefox" ])
    end

    %w[CI Production TZ].each do |env|
        output = "#{env}-test-results.xml"

        file output => DEPS do |t|
            sh *(GRUNT_CMD + [ "jshint", "karma", "--junit-results=#{output}", "--single-run=true" ])
        end

        desc "Run #{env} tests"
        task env => [output, :java] do
            sh "touch #{output}"
        end
    end
end
