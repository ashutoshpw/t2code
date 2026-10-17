#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface T2SourceTextManager : RCTViewManager
@end

@implementation T2SourceTextManager

RCT_EXPORT_MODULE(T2SourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface T2SourceTextRunManager : RCTViewManager
@end

@implementation T2SourceTextRunManager

RCT_EXPORT_MODULE(T2SourceTextRun)

- (UIView *)view {
  return nil;
}

@end
