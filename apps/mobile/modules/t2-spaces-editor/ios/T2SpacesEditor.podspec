Pod::Spec.new do |s|
  s.name = 'T2SpacesEditor'
  s.version = '1.0.0'
  s.summary = 'Native rich text block editor spike for T2 Code Spaces.'
  s.author = 'W3 Dev LLC'
  s.homepage = 'https://t2tools.com'
  s.platforms = { :ios => '16.4' }
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
