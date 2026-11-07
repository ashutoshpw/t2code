Pod::Spec.new do |s|
  s.name = 'T2VoiceTranscription'
  s.version = '1.0.0'
  s.summary = 'Local recording conversion for T2 Code dictation.'
  s.author = 'W3 Dev LLC'
  s.homepage = 'https://t2tools.com'
  s.platform = :ios, '18.0'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'AudioToolbox'
end
