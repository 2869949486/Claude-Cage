package guestos

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Execute the production receipt/prepare/finish transaction with directory
// services replaced by a file fixture. No command can access real OS accounts.
func TestMacSetupUnifiedAccountTransaction(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "scripts", "guest-os", "macos-setup-account.m"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	start, end := strings.Index(source, "static NSArray *users("), strings.Index(source, "static void save(")
	if start < 0 || end <= start {
		t.Fatal("directory lookup seam changed")
	}
	source = source[:start] + `static NSArray *users(ODNode *node, NSString *name) { return fixtureUsers(name); }
` + source[end:]
	source = strings.ReplaceAll(source, `#import "macos-guest-identity.h"`, `static BOOL cageIsVirtualMac(void) { return YES; }`)
	source = strings.ReplaceAll(source, `@"/var/db/cage-initial-setup"`, `@"FIXTURE_ROOT/setup"`)
	source = strings.ReplaceAll(source, `"/var/db/cage-guest-os"`, `"FIXTURE_ROOT/marker"`)
	source = strings.ReplaceAll(source, `@"/var/db/cage-guest-os"`, `@"FIXTURE_ROOT/marker"`)
	source = strings.ReplaceAll(source, "getuid() == 0", "getuid() == getuid()")
	source = strings.ReplaceAll(source, "st.st_uid == 0", "st.st_uid == getuid()")
	source = strings.ReplaceAll(source, `[ODNode nodeWithSession:[ODSession defaultSession] name:@"/Local/Default" error:NULL]`, `(ODNode *)[FixtureNode new]`)
	source = strings.ReplaceAll(source, "NSTask", "FixtureTask")
	root := t.TempDir()
	source = strings.ReplaceAll(source, "FIXTURE_ROOT", root)
	if err := os.WriteFile(filepath.Join(root, "marker"), []byte("macos\n"), 0600); err != nil {
		t.Fatal(err)
	}
	harness := `#import <Foundation/Foundation.h>
#import <OpenDirectory/OpenDirectory.h>
static NSMutableDictionary *directoryState(void) {
    NSData *data = [NSData dataWithContentsOfFile:@(getenv("CAGE_DIRECTORY_FIXTURE"))];
    return [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL];
}
static void storeDirectory(NSMutableDictionary *state) {
    [[NSJSONSerialization dataWithJSONObject:state options:0 error:NULL] writeToFile:@(getenv("CAGE_DIRECTORY_FIXTURE")) atomically:YES];
}
@interface FixtureUser : NSObject
@property BOOL legacy;
@end
@implementation FixtureUser
- (NSArray *)valuesForAttribute:(NSString *)attribute error:(NSError **)error {
    NSDictionary *state = directoryState();
    if ([attribute isEqual:kODAttributeTypeGUID]) return @[state[self.legacy ? @"legacy_guid" : @"guid"]];
    if ([attribute isEqual:kODAttributeTypeUniqueID]) return @[self.legacy ? @"503" : @"502"];
    if ([attribute isEqual:kODAttributeTypeUserShell]) return @[state[@"legacy_shell"] ?: @"/bin/zsh"];
    return @[];
}
- (BOOL)verifyPassword:(NSString *)password error:(NSError **)error { return [password isEqual:@"fixture-pass-123!"]; }
- (BOOL)authenticationAllowedAndReturnError:(NSError **)error {
    if (self.legacy && [directoryState()[@"legacy_disabled"] boolValue]) {
        if (error) *error = [NSError errorWithDomain:ODFrameworkErrorDomain code:kODErrorCredentialsAccountDisabled userInfo:nil];
        return NO;
    }
    return YES;
}
- (BOOL)changePassword:(NSString *)old toPassword:(NSString *)target error:(NSError **)error {
    if (!self.legacy) abort();
    NSMutableDictionary *state = directoryState(); state[@"legacy_password_retired"] = @YES; storeDirectory(state); return YES;
}
- (BOOL)setValue:(NSString *)value forAttribute:(NSString *)attribute error:(NSError **)error {
    if (!self.legacy || ![attribute isEqual:kODAttributeTypeUserShell]) abort();
    NSMutableDictionary *state = directoryState(); state[@"legacy_shell"] = value; storeDirectory(state); return YES;
}
@end
static NSArray *fixtureUsers(NSString *name) {
    FixtureUser *user = [FixtureUser new]; user.legacy = [name isEqual:@"cagesetup"];
    if (user.legacy && !directoryState()[@"legacy_guid"]) return @[];
    if (!user.legacy && ![name isEqual:@"trial"]) return @[];
    return @[user];
}
@interface FixtureGroup : NSObject @end
@implementation FixtureGroup
- (BOOL)isMemberRecord:(FixtureUser *)user error:(NSError **)error { return [directoryState()[user.legacy ? @"legacy_admin" : @"admin"] boolValue]; }
- (BOOL)setMember:(FixtureUser *)user value:(BOOL)value { NSMutableDictionary *state = directoryState(); state[user.legacy ? @"legacy_admin" : @"admin"] = @(value); storeDirectory(state); return YES; }
- (BOOL)addMemberRecord:(FixtureUser *)user error:(NSError **)error { return [self setMember:user value:YES]; }
- (BOOL)removeMemberRecord:(FixtureUser *)user error:(NSError **)error { return [self setMember:user value:NO]; }
- (BOOL)synchronizeAndReturnError:(NSError **)error { return YES; }
@end
@interface FixtureNode : NSObject @end
@implementation FixtureNode
- (id)recordWithRecordType:(id)type name:(id)name attributes:(id)attrs error:(NSError **)error { return [FixtureGroup new]; }
@end
@interface FixtureTask : NSObject
@property NSURL *executableURL;
@property NSArray *arguments;
@property id standardInput;
@property id standardOutput;
@property id standardError;
@property int terminationStatus;
@end
@implementation FixtureTask
- (BOOL)launchAndReturnError:(NSError **)error {
    if (![self.executableURL.path isEqual:@"/usr/bin/pwpolicy"]) abort();
    NSMutableDictionary *state = directoryState(); state[@"legacy_disabled"] = @YES; storeDirectory(state); return YES;
}
- (void)waitUntilExit {}
@end
` + source
	program := filepath.Join(root, "setup-helper")
	compile := exec.CommandContext(t.Context(), "clang", "-x", "objective-c", "-fobjc-arc", "-", "-framework", "Foundation", "-framework", "OpenDirectory", "-o", program)
	compile.Stdin = strings.NewReader(harness)
	if out, err := compile.CombinedOutput(); err != nil {
		t.Fatalf("compile isolated account transaction: %v\n%s", err, out)
	}
	stateFile, receiptFile := filepath.Join(root, "directory.json"), filepath.Join(root, "setup", "account.json")
	write := func(path string, value any) {
		t.Helper()
		data, _ := json.Marshal(value)
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	read := func(path string) map[string]any {
		t.Helper()
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var value map[string]any
		if err = json.Unmarshal(data, &value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	run := func(ok bool, args ...string) {
		t.Helper()
		cmd := exec.CommandContext(t.Context(), program, args...)
		cmd.Env = append(os.Environ(), "CAGE_DIRECTORY_FIXTURE="+stateFile)
		cmd.Stdin = strings.NewReader("fixture-pass-123!\n")
		out, err := cmd.CombinedOutput()
		if (err == nil) != ok {
			t.Fatalf("operation %v: %v %s", args, err, out)
		}
	}
	id, guid, legacy := "12345678-1234-1234-1234-123456789012", "12345678-1234-1234-1234-123456789013", "12345678-1234-1234-1234-123456789014"
	write(stateFile, map[string]any{"guid": guid, "admin": true})
	run(false, "prepare", id, "trial")
	write(stateFile, map[string]any{"guid": guid, "admin": false, "home": "/Users/trial", "credential_marker": "retained"})
	run(true, "prepare", id, "trial")
	run(true, "prepare", id, "trial")
	if state := read(stateFile); state["admin"] != true || state["legacy_guid"] != nil {
		t.Fatal("prepare did not elevate the bound user alone", state)
	}
	run(true)
	run(true)
	run(true, "prepare", id, "trial")
	if read(stateFile)["admin"] != false {
		t.Fatal("finish/replay restored administrator membership")
	}
	if state := read(stateFile); state["home"] != "/Users/trial" || state["credential_marker"] != "retained" {
		t.Fatal("retirement changed the ordinary account's data")
	}
	receipt := read(receiptFile)
	receipt["state"] = "retiring"
	write(receiptFile, receipt)
	state := read(stateFile)
	state["admin"] = true
	write(stateFile, state)
	run(true, "prepare", id, "trial")
	if read(stateFile)["admin"] != false || read(receiptFile)["state"] != "retired" {
		t.Fatal("interrupted retirement was not completed")
	}
	state = read(stateFile)
	state["guid"] = legacy
	write(stateFile, state)
	run(false, "prepare", id, "trial")
	if read(stateFile)["admin"] != false {
		t.Fatal("a replaced account acquired privileges")
	}
	write(stateFile, map[string]any{"guid": guid, "admin": false, "legacy_guid": legacy, "legacy_admin": true})
	write(receiptFile, map[string]any{"installation": id, "user": "trial", "ordinary_guid": guid, "guid": legacy, "uid": 503, "state": "ready"})
	state = read(stateFile)
	state["legacy_guid"] = id
	write(stateFile, state)
	run(false, "prepare", id, "trial")
	if read(stateFile)["admin"] != false || read(stateFile)["legacy_admin"] != true {
		t.Fatal("a mismatched legacy account was modified")
	}
	state["legacy_guid"] = legacy
	write(stateFile, state)
	run(true, "prepare", id, "trial")
	state = read(stateFile)
	if state["admin"] != true || state["legacy_admin"] != false || state["legacy_disabled"] != true || state["legacy_shell"] != "/usr/bin/false" {
		t.Fatal("legacy migration did not retire the separate account", state)
	}
	run(true)
	if read(stateFile)["admin"] != false {
		t.Fatal("migrated account retained administrator membership")
	}
}
