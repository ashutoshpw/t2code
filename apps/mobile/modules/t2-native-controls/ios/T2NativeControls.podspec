Pod::Spec.new do |s|
  s.name           = 'T2NativeControls'
  s.version        = '1.0.0'
  s.summary        = 'Native UIKit controls for T2 Code mobile.'
  s.description    = 'UIKit-backed controls that match native iOS navigation chrome.'
  s.author         = 'T2 Tools'
  s.homepage       = 'https://t2tools.com'
  s.platforms      = {
    :ios => '18.0',
  }
  s.source         = { :path => '.' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }
  s.source_files = '**/*.{h,m,mm,swift,hpp,cpp}'
end
