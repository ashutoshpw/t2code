#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface T2MarkdownTextManager : RCTViewManager
@end

@implementation T2MarkdownTextManager

RCT_EXPORT_MODULE(T2MarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface T2MarkdownTextRunManager : RCTViewManager
@end

@implementation T2MarkdownTextRunManager

RCT_EXPORT_MODULE(T2MarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
