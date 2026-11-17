require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name             = 'HomeIcon'
  s.version          = package['version'] || '1.0.0'
  s.summary          = package['description'] || 'HomeIcon native helper module'
  s.description      = package['description'] || 'HomeIcon native helper module'
  s.license          = package['license'] || 'MIT'
  s.author           = package['author'] || 'MyLike'
  s.homepage         = package['homepage'] || 'https://github.com/KANGLLY/mylike-mobile-enhanced'
  s.platforms        = { :ios => '16.4' }
  s.swift_version    = '5.9'
  s.source           = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
