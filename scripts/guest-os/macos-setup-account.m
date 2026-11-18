#import "macos-guest-identity.h"
// First setup temporarily elevates the bound ordinary account, then removes
// that membership. Root-only receipts bind its directory GUID and numeric uid.
#import <Foundation/Foundation.h>
#import <OpenDirectory/OpenDirectory.h>
#include <pwd.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>

static NSString *const directory = @"/var/db/cage-initial-setup";
static NSString *const setup = @"cagesetup";

static void require(BOOL ok, const char *reason) {
    if (!ok) { fprintf(stderr, "%s\n", reason); exit(1); }
}

static NSArray *users(ODNode *node, NSString *name) {
    ODQuery *q = [ODQuery queryWithNode:node forRecordTypes:kODRecordTypeUsers
        attribute:kODAttributeTypeRecordName matchType:kODMatchEqualTo queryValues:name
        returnAttributes:@[kODAttributeTypeGUID, kODAttributeTypeUniqueID] maximumResults:2 error:NULL];
    NSArray *results = [q resultsAllowingPartial:NO error:NULL];
    require(results != nil && results.count <= 1, "Cannot identify the local guest user.");
    return results;
}

static void save(NSDictionary *d, NSURL *file) {
    NSData *data = [NSJSONSerialization dataWithJSONObject:d options:0 error:NULL];
    require(data && [data writeToURL:file options:NSDataWritingAtomic error:NULL], "Cannot persist the guest setup receipt.");
}

static BOOL member(ODRecord *group, ODRecord *user) {
    NSError *err = nil;
    BOOL result = [group isMemberRecord:user error:&err];
    require(!err, "Cannot inspect guest administrator privileges.");
    return result;
}

static void setMember(ODRecord *group, ODRecord *user, BOOL expected) {
    if (member(group, user) == expected) return;
    require(expected ? [group addMemberRecord:user error:NULL] : [group removeMemberRecord:user error:NULL],
        expected ? "Cannot grant temporary setup privileges." : "Cannot revoke setup administrator privileges.");
    require([group synchronizeAndReturnError:NULL], "Cannot synchronize guest administrator privileges.");
    // OD membership queries use the system membership cache. After a successful
    // directory write, wait briefly for that cache to reflect the committed state.
    for (int attempt = 0; attempt < 50; attempt++) {
        if (member(group, user) == expected) return;
        usleep(100000);
    }
    require(NO, expected ? "Guest setup privileges were not applied." : "The setup user still has administrator privileges.");
}

static BOOL disabled(ODRecord *record) {
    NSError *error = nil;
    BOOL allowed = [record authenticationAllowedAndReturnError:&error];
    return !allowed && [error.domain isEqual:ODFrameworkErrorDomain] && error.code == kODErrorCredentialsAccountDisabled;
}

static NSString *readPassword(void) {
    char buf[258] = {0};
    require(fgets(buf,sizeof(buf),stdin) != NULL, "Missing virtual Mac password.");
    size_t len = strcspn(buf,"\r\n");
    require(len >= 8 && len <= 256 && buf[len] == '\n', "Invalid virtual Mac password.");
    for (size_t i = 0; i < len; i++) require(buf[i] >= 32 && buf[i] <= 126, "Unsupported virtual Mac password character.");
    NSString *pw = [[NSString alloc] initWithBytes:buf length:len encoding:NSUTF8StringEncoding];
    memset_s(buf,sizeof(buf),0,sizeof(buf));
    require(pw != nil, "Invalid password encoding.");
    return pw;
}

static void updatePassword(ODRecord *record, NSString *old, NSString *target) {
    if ([record verifyPassword:target error:NULL]) return;
    require([record verifyPassword:old error:NULL] && [record changePassword:old toPassword:target error:NULL] &&
        [record verifyPassword:target error:NULL], "Cannot synchronize the guest account password.");
}

// security -i accepts double-quoted tokens with escaped quotes/backslashes.
// Its commands travel on a private pipe; no password enters process arguments.
static NSString *securityToken(NSString *value) {
    return [NSString stringWithFormat:@"\"%@\"", [[value stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
        stringByReplacingOccurrencesOfString:@"\"" withString:@"\\\""]];
}

static void synchronize(ODRecord *ordinary, ODRecord *setupRecord, NSDictionary *receipt, NSString *name) {
    NSString *old = readPassword(), *target = readPassword();
    NSString *home = [ordinary valuesForAttribute:kODAttributeTypeNFSHomeDirectory error:NULL].firstObject;
    require([home isEqual:[@"/Users/" stringByAppendingString:name]], "Unexpected guest home directory.");
    NSString *domain = @"/Library/Preferences/com.apple.loginwindow";
    NSDictionary *preferences = [NSDictionary dictionaryWithContentsOfFile:[domain stringByAppendingString:@".plist"]];
    require(!preferences[@"autoLoginUser"] || [preferences[@"autoLoginUser"] isEqual:name], "Automatic login belongs to another guest user.");
    struct stat st;
    require(lstat("/etc/kcpassword",&st) != 0 ? errno == ENOENT : S_ISREG(st.st_mode) && st.st_uid == 0,
        "Invalid system automatic login file.");
    // Keep the existing login keychain usable after the system account changes.
    // Each step accepts the target password, so retries can finish partial work.
    NSString *keychainPath = [home stringByAppendingString:@"/Library/Keychains/login.keychain-db"];
    if (lstat(keychainPath.fileSystemRepresentation,&st) == 0) {
        require(S_ISREG(st.st_mode), "Invalid guest login keychain.");
        NSString *commands = [NSString stringWithFormat:@"set-keychain-password -o %@ -p %@ %@\nunlock-keychain -p %@ %@\n",
            securityToken(old),securityToken(target),securityToken(keychainPath),securityToken(target),securityToken(keychainPath)];
        NSPipe *input = [NSPipe pipe];
        NSTask *security = [[NSTask alloc] init];
        security.executableURL = [NSURL fileURLWithPath:@"/usr/bin/security"];
        security.arguments = @[@"-i"];
        security.standardInput = input;
        security.standardOutput = security.standardError = [NSFileHandle fileHandleWithNullDevice];
        require([security launchAndReturnError:NULL], "Cannot invoke the guest keychain tool.");
        [input.fileHandleForWriting writeData:[commands dataUsingEncoding:NSUTF8StringEncoding]];
        [input.fileHandleForWriting closeFile];
        [security waitUntilExit];
        require(security.terminationStatus == 0, "Cannot synchronize the guest login keychain; existing data was retained.");
    } else require(errno == ENOENT, "Cannot inspect the guest login keychain.");
    updatePassword(ordinary,old,target);
    if ([receipt[@"version"] intValue] != 2 && [receipt[@"state"] isEqual:@"ready"]) {
        require(setupRecord && !disabled(setupRecord), "The initial setup account is unavailable.");
        updatePassword(setupRecord,old,target);
    }
    unsigned char key[] = {0x7d,0x89,0x52,0x23,0xd2,0xbc,0xdd,0xea,0xa3,0xb9,0x1f};
    NSMutableData *encoded = [[target dataUsingEncoding:NSUTF8StringEncoding] mutableCopy];
    [encoded increaseLengthBy:1];
    while (encoded.length % 12) [encoded increaseLengthBy:1];
    unsigned char *bytes = encoded.mutableBytes;
    for (NSUInteger i=0; i<encoded.length; i++) bytes[i] ^= key[i % sizeof(key)];
    require([encoded writeToFile:@"/etc/kcpassword" options:NSDataWritingAtomic error:NULL] && chmod("/etc/kcpassword",0600) == 0,
        "Cannot synchronize automatic login.");
    // This call contains only the non-secret account name.
    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/defaults"];
    task.arguments = @[@"write", domain, @"autoLoginUser", @"-string", name];
    require([task launchAndReturnError:NULL], "Cannot configure automatic login.");
    [task waitUntilExit]; require(task.terminationStatus == 0, "Cannot persist automatic login user.");
}

static void retire(ODNode *node, ODRecord *admin, ODRecord *record) {
    setMember(admin, record, NO);
    if (!disabled(record)) {
        // Invalidate the initial guest password before disabling the account.
        // This replacement is never persisted or exposed to a caller.
        NSString *replacement = [@"Z9!" stringByAppendingString:NSUUID.UUID.UUIDString];
        require([record changePassword:nil toPassword:replacement error:NULL], "Cannot clear the temporary guest credential.");
        require([record setValue:@"/usr/bin/false" forAttribute:kODAttributeTypeUserShell error:NULL], "Cannot close the temporary login shell.");
        NSTask *task = [[NSTask alloc] init];
        task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/pwpolicy"];
        task.arguments = @[@"-n", @"/Local/Default", @"-u", setup, @"-disableuser"];
        require([task launchAndReturnError:NULL], "Cannot invoke the guest account policy tool.");
        [task waitUntilExit];
        require(task.terminationStatus == 0, "Cannot disable the temporary guest user.");
    }
    ODRecord *current = users(node, setup).firstObject;
    require(current && disabled(current) && !member(admin, current) &&
        [[current valuesForAttribute:kODAttributeTypeUserShell error:NULL].firstObject isEqual:@"/usr/bin/false"],
        "The temporary guest login remains available.");
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        BOOL prepare = (argc == 3 || argc == 4) && strcmp(argv[1], "prepare") == 0;
        BOOL password = argc == 4 && strcmp(argv[1], "password") == 0;
        require(prepare || password || argc == 1, "Invalid first setup operation.");
        struct stat st;
        require(getuid() == 0 && cageIsVirtualMac() && lstat("/var/db/cage-guest-os", &st) == 0 &&
            S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 022) &&
            [[NSString stringWithContentsOfFile:@"/var/db/cage-guest-os" encoding:NSUTF8StringEncoding error:NULL] isEqual:@"macos\n"],
            "Run as root in the selected Cage virtual Mac.");
        umask(077);
        if (prepare && mkdir(directory.fileSystemRepresentation, 0700) != 0) require(errno == EEXIST, "Cannot create private receipt directory.");
        require(lstat(directory.fileSystemRepresentation, &st) == 0 && S_ISDIR(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 077),
            "Invalid private setup directory.");
        NSString *lockPath = [directory stringByAppendingPathComponent:@"lock"];
        int lock = open(lockPath.fileSystemRepresentation, O_NOFOLLOW|O_CREAT|O_RDWR, 0600);
        require(lock >= 0 && flock(lock, LOCK_EX|LOCK_NB) == 0, "Another first setup operation is running.");
        NSURL *file = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:@"account.json"]];
        NSData *data = nil;
        if (lstat(file.fileSystemRepresentation, &st) == 0) {
            require(S_ISREG(st.st_mode) && st.st_uid == 0 && !(st.st_mode & 077) && st.st_size > 0 && st.st_size <= 2048,
                "Invalid guest setup receipt.");
            data = [NSData dataWithContentsOfURL:file]; require(data != nil,"Unreadable guest setup receipt.");
        } else require(errno == ENOENT && prepare, "Missing guest setup receipt.");
        ODNode *node = [ODNode nodeWithSession:[ODSession defaultSession] name:@"/Local/Default" error:NULL];
        ODRecord *admin = [node recordWithRecordType:kODRecordTypeGroups name:@"admin" attributes:nil error:NULL];
        NSString *install = prepare || password ? @(argv[2]) : nil;
        if (install) require([[NSUUID alloc] initWithUUIDString:install] != nil, "Invalid fresh guest installation ID.");
        NSMutableDictionary *receipt = nil;
        if (data) {
            receipt = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:NULL];
            require([receipt isKindOfClass:NSMutableDictionary.class] &&
                [[NSUUID alloc] initWithUUIDString:receipt[@"installation"]] && (!install || [receipt[@"installation"] isEqual:install]),
                "The setup account belongs to a different installation.");
        }
        NSString *ordinaryName = argc == 4 ? @(argv[3]) : receipt[@"user"] ?: @"cage";
        NSRegularExpression *userPattern = [NSRegularExpression regularExpressionWithPattern:@"^[a-z][a-z0-9_]{0,30}$" options:0 error:NULL];
        require([userPattern numberOfMatchesInString:ordinaryName options:0 range:NSMakeRange(0,ordinaryName.length)] == 1 &&
            ![@[@"root",@"cagesetup",@"cageprovision"] containsObject:ordinaryName], "Invalid ordinary guest username.");
        require(!data || [ordinaryName isEqual:receipt[@"user"] ?: @"cage"], "The receipt belongs to another ordinary account.");
        ODRecord *ordinary = users(node, ordinaryName).firstObject;
        require(node && admin && ordinary, "The bound guest account is unavailable.");
        NSString *ordinaryGUID = [ordinary valuesForAttribute:kODAttributeTypeGUID error:NULL].firstObject;
        NSString *ordinaryUID = [ordinary valuesForAttribute:kODAttributeTypeUniqueID error:NULL].firstObject;
        require(ordinaryGUID && (!receipt[@"ordinary_guid"] || [receipt[@"ordinary_guid"] isEqual:ordinaryGUID]), "The ordinary guest account has changed.");
        require([ordinaryUID intValue] >= 501, "Invalid ordinary guest UID.");
        if (!data) {
            require(!member(admin,ordinary), "An existing administrator cannot be claimed for first setup.");
            receipt = [@{@"version":@2, @"installation":install, @"user":ordinaryName,
                @"ordinary_guid":ordinaryGUID, @"ordinary_uid":ordinaryUID, @"state":@"creating"} mutableCopy];
            save(receipt,file);
        }
        BOOL unified = [receipt[@"version"] intValue] == 2;
        require(unified || !receipt[@"version"], "Unknown setup receipt version.");
        ODRecord *record = nil;
        if (unified) {
            require([receipt[@"ordinary_uid"] isEqual:ordinaryUID] && [receipt[@"ordinary_guid"] isEqual:ordinaryGUID],
                "Refusing to modify a replaced guest account.");
        } else {
            // Older installers created a separate hidden administrator. Only a
            // matching receipt allows that account to be retired during migration.
            require(!member(admin,ordinary) && [[NSUUID alloc] initWithUUIDString:receipt[@"guid"]] && [receipt[@"uid"] intValue] >= 502,
                "Invalid legacy setup identity.");
            record = users(node, setup).firstObject;
            if (record) {
                NSString *guid = [record valuesForAttribute:kODAttributeTypeGUID error:NULL].firstObject;
                NSString *uid = [record valuesForAttribute:kODAttributeTypeUniqueID error:NULL].firstObject;
                require(guid && [guid caseInsensitiveCompare:receipt[@"guid"]] == NSOrderedSame && [uid isEqual:[receipt[@"uid"] stringValue]],
                    "Refusing to modify an unrelated guest user.");
            }
        }
        NSString *phase = receipt[@"state"];
        require([@[@"creating",@"ready",@"retiring",@"retired"] containsObject:phase], "Unknown guest setup state.");
        if (password) {
            require(![phase isEqual:@"creating"] && ![phase isEqual:@"retiring"], "Finish guest account preparation before changing its password.");
            synchronize(ordinary,record,receipt,ordinaryName);
            save(receipt,file); close(lock); return 0;
        }
        if (prepare) {
            NSString *pw = readPassword();
            require([ordinary verifyPassword:pw error:NULL] && !disabled(ordinary), "The stored credential does not match this guest.");
            // A lost finish response must remain retryable after restart. Once
            // retirement has begun, preparation can only finish revocation.
            if ([phase isEqual:@"retiring"] || [phase isEqual:@"retired"]) {
                if (unified) setMember(admin,ordinary,NO);
                else if (record) retire(node,admin,record);
                receipt[@"state"] = @"retired"; save(receipt,file); close(lock); return 0;
            }
            if (!unified) {
                if (record) retire(node,admin,record);
                receipt = [@{@"version":@2, @"installation":receipt[@"installation"], @"user":ordinaryName,
                    @"ordinary_guid":ordinaryGUID, @"ordinary_uid":ordinaryUID, @"state":@"creating"} mutableCopy];
                save(receipt,file);
            }
            setMember(admin, ordinary, YES);
            receipt[@"state"] = @"ready";
        } else {
            require(![phase isEqual:@"creating"], "The temporary account has not completed setup.");
            if (![phase isEqual:@"retired"]) {
                receipt[@"state"] = @"retiring"; save(receipt,file);
            }
            if (unified) setMember(admin, ordinary, NO);
            else if (record) retire(node, admin, record);
            require(!member(admin,ordinary), "The regular Cage user is a guest administrator.");
            receipt[@"state"] = @"retired";
        }
        save(receipt,file);
        close(lock);
        return 0;
    }
}
