#import "T2SourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "T2SourceTextRunComponentDescriptor.h"
#import <react/renderer/components/T2SourceTextSpec/Props.h>
#import <react/renderer/components/T2SourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface T2SourceTextRun () <RCTT2SourceTextRunViewProtocol>

@end

@implementation T2SourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      T2SourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const T2SourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<T2SourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<T2SourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> T2SourceTextRunCls(void) {
  return T2SourceTextRun.class;
}

@end
