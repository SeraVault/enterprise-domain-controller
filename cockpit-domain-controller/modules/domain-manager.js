/**
 * Domain Management Module
 * Handles domain provisioning, joining, and leaving operations
 */

const _ = cockpit.gettext;

export class DomainManager {
    constructor(uiManager) {
        this.uiManager = uiManager;
    }

    /**
     * Provision a new Active Directory domain
     */
    async provisionDomain() {
        const domainName = document.getElementById('domain-name-input').value.trim();
        const netbiosName = (document.getElementById('netbios-name')?.value.trim() ||
                             domainName.split('.')[0].toUpperCase()).toUpperCase();
        const adminPassword = document.getElementById('admin-password').value;
        const hostname = document.getElementById('provision-hostname').value.trim();
        const selectedInterface = document.getElementById('provision-interface').value;

        // Required field validation
        if (!domainName || !adminPassword || !hostname || !selectedInterface) {
            this.uiManager.showError(_("Please fill in all required fields"));
            return;
        }

        if (!this.validateDomainName(domainName)) {
            this.uiManager.showError(_("Domain name must be a valid FQDN (e.g., example.com)"));
            return;
        }

        if (!this.validateNetbiosName(netbiosName)) {
            this.uiManager.showError(_("NetBIOS name must be 15 characters or less and contain only letters, numbers, and hyphens"));
            return;
        }

        if (!this.validateHostname(hostname, domainName)) {
            this.uiManager.showError(_("Hostname must be a valid FQDN within the domain (e.g., dc1.example.com)"));
            return;
        }

        // Collect advanced options
        const options = {
            dnsBackend:    document.getElementById('dns-backend')?.value || 'SAMBA_INTERNAL',
            forestLevel:   document.getElementById('forest-level')?.value || '2008_R2',
            useRfc2307:    document.getElementById('use-rfc2307')?.checked ?? true,
            ntpServers:    document.getElementById('ntp-servers')?.value || null,
            dnsForwarder:  document.getElementById('dns-forwarder')?.value?.trim() || '8.8.8.8',
            siteName:      document.getElementById('site-name')?.value?.trim() || '',
            enableDhcp:    document.getElementById('enable-dhcp')?.checked ?? true,
            dhcpRangeStart: document.getElementById('dhcp-provision-range-start')?.value?.trim() || '',
            dhcpRangeEnd:   document.getElementById('dhcp-provision-range-end')?.value?.trim() || '',
        };

        this.uiManager.showLoading(_("Provisioning domain ") + domainName + _('...'));

        try {
            await this.performDomainProvisioning(domainName, netbiosName, adminPassword, hostname, selectedInterface, options);
        } catch (error) {
            console.error('Domain provisioning failed:', error);
            this.uiManager.hideLoading();
            this.uiManager.showError(_("Failed to provision domain: ") + error.message);
        }
    }

    /**
     * Join an existing Active Directory domain
     */
    async joinDomain() {
        const domainName = document.getElementById('existing-domain').value.trim();
        const hostname = document.getElementById('join-hostname').value.trim();
        const domainControllerIP = document.getElementById('domain-controller-ip').value.trim();
        const username = document.getElementById('domain-user').value.trim();
        const password = document.getElementById('domain-password').value;
        const selectedInterface = document.getElementById('join-interface').value;
        
        if (!domainName || !hostname || !domainControllerIP || !username || !password || !selectedInterface) {
            this.uiManager.showError(_("Please fill in all required fields"));
            return;
        }
        
        if (!this.validateHostname(hostname, domainName)) {
            this.uiManager.showError(_("Hostname must be a valid FQDN within the domain (e.g., dc2.example.com)"));
            return;
        }

        this.uiManager.showLoading(_("Testing connectivity to domain controller..."));

        // Collect advanced options
        const options = {
            dnsBackend:   document.getElementById('join-dns-backend')?.value || 'SAMBA_INTERNAL',
            dnsForwarder: document.getElementById('join-dns-forwarder')?.value?.trim() || '',
            siteName:     document.getElementById('join-site-name')?.value?.trim() || '',
            criticalOnly: document.getElementById('join-critical-only')?.checked ?? false,
        };

        try {
            await this.setHostname(hostname);
            await this.testDomainControllerConnectivity(domainControllerIP, domainName);
            await this.performDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface, options);
        } catch (error) {
            console.error('Domain join failed:', error);
            this.uiManager.hideLoading();
            this.uiManager.showError(_("Failed to join domain: ") + error.message);
        }
    }

    /**
     * Leave the current domain
     */
    async leaveDomain() {
        if (!confirm(_("Are you sure you want to leave the domain? This will remove all domain configurations."))) {
            return;
        }

        this.uiManager.showLoading();
        
        try {
            // First try to demote properly
            await cockpit.spawn(['samba-tool', 'domain', 'demote'], { superuser: "try" });
            this.uiManager.hideLoading();
            this.uiManager.updateDomainStatus(null);
            this.uiManager.showSuccess(_("Successfully left the domain"));
        } catch (error) {
            console.error('Demote failed:', error);
            // If demote fails, try manual cleanup
            await this.forceLeaveCleanup();
        }
    }

    /**
     * Perform comprehensive domain cleanup
     */
    async forceLeaveCleanup() {
        console.log('Attempting comprehensive domain cleanup...');
        
        const cleanupCommands = [
            // Stop all domain-related services
            ['systemctl', 'stop', 'samba-ad-dc'],
            ['systemctl', 'stop', 'isc-dhcp-server'],
            ['systemctl', 'stop', 'chrony'],
            ['systemctl', 'stop', 'dhcp-fsmo-monitor.timer'],
            ['systemctl', 'stop', 'ntp-fsmo-monitor.timer'],
            
            // Disable services
            ['systemctl', 'disable', 'samba-ad-dc'],
            ['systemctl', 'disable', 'dhcp-fsmo-monitor.timer'],
            ['systemctl', 'disable', 'ntp-fsmo-monitor.timer'],
            
            // Remove configurations
            ['rm', '-rf', '/etc/samba/smb.conf'],
            ['rm', '-rf', '/etc/samba/smb.conf.backup'],
            ['rm', '-rf', '/var/lib/samba/private'],
            ['rm', '-rf', '/var/lib/samba/sysvol'],
            ['rm', '-rf', '/var/cache/samba'],
            ['rm', '-rf', '/var/log/samba'],
            
            // Remove FSMO components
            ['rm', '-rf', '/usr/local/bin/dhcp-fsmo-manager.sh'],
            ['rm', '-rf', '/usr/local/bin/ntp-fsmo-manager.sh'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/dhcp-fsmo-monitor.timer'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.service'],
            ['rm', '-rf', '/etc/systemd/system/ntp-fsmo-monitor.timer'],
            
            // Reload systemd
            ['systemctl', 'daemon-reload'],
            
            // Reset services
            ['systemctl', 'enable', 'chrony'],
            ['systemctl', 'start', 'chrony']
        ];

        try {
            for (const command of cleanupCommands) {
                console.log('Running cleanup command:', command.join(' '));
                try {
                    await cockpit.spawn(command, { superuser: "try" });
                } catch (err) {
                    console.log('Cleanup command failed (may be expected):', err);
                }
            }

            // Write basic configuration files
            await this.writeBasicConfigurations();

            this.uiManager.hideLoading();
            this.uiManager.updateDomainStatus(null);
            this.uiManager.showSuccess(_("Complete domain cleanup finished. Server is ready for fresh domain setup."));
        } catch (error) {
            this.uiManager.hideLoading();
            console.error('Cleanup failed:', error);
            this.uiManager.showError(_("Domain cleanup partially failed: ") + error.message);
        }
    }

    /**
     * Write basic configuration files after cleanup
     */
    async writeBasicConfigurations() {
        const basicDhcpConfig = `# Basic DHCP configuration - NOT domain integrated
# Please configure according to your network requirements

default-lease-time 600;
max-lease-time 7200;
ddns-update-style none;
authoritative;

# Log facility configuration
log-facility local7;
`;

        const basicKrb5Config = `[libdefaults]
	default_realm = EXAMPLE.COM
	kdc_timesync = 1
	ccache_type = 4
	forwardable = true
	proxiable = true
	rdns = false
	fcc-mit-ticketflags = true
	udp_preference_limit = 0
`;

        await cockpit.file('/etc/dhcp/dhcpd.conf', { superuser: "try" }).replace(basicDhcpConfig);
        await cockpit.file('/etc/krb5.conf', { superuser: "try" }).replace(basicKrb5Config);
    }

    /**
     * Validation methods
     */
    validateDomainName(domain) {
        const domainRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.([a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?\.)*[a-zA-Z]{2,}$/;
        return domainRegex.test(domain);
    }

    validateNetbiosName(netbios) {
        return netbios && netbios.length <= 15 && /^[a-zA-Z0-9-]+$/.test(netbios);
    }

    validateHostname(hostname, domain) {
        return hostname && hostname.endsWith('.' + domain) && this.validateDomainName(hostname);
    }

    /**
     * Set system hostname
     */
    async setHostname(hostname) {
        await cockpit.spawn(['hostnamectl', 'set-hostname', hostname], { superuser: "try" });
    }

    /**
     * Test connectivity to domain controller
     */
    async testDomainControllerConnectivity(dcIP, domainName) {
        // Test basic network connectivity
        await cockpit.spawn(['ping', '-c', '2', '-W', '3', dcIP], { superuser: "try" });
        
        // Test SMB port connectivity
        await cockpit.spawn(['nc', '-z', '-w', '5', dcIP, '445'], { superuser: "try" });
    }

    /**
     * Update Kerberos configuration for domain operations
     */
    async updateKerberosConfig(domainName, dcHostname) {
        const realm = domainName.toUpperCase();
        const domain = domainName.toLowerCase();
        
        const krb5Config = `[libdefaults]
default_realm = ${realm}
kdc_timesync = 1
ccache_type = 4
forwardable = true
proxiable = true
rdns = false
fcc-mit-ticketflags = true
udp_preference_limit = 0

[realms]
\t${realm} = {
\t\tkdc = ${dcHostname}:88
\t\tadmin_server = ${dcHostname}:749
\t\tdefault_domain = ${domain}
\t}

[domain_realm]
\t.${domain} = ${realm}
\t${domain} = ${realm}
`;
        
        try {
            await cockpit.file('/etc/krb5.conf', { superuser: "try" }).replace(krb5Config);
            console.log('Kerberos configuration updated successfully');
        } catch (error) {
            console.error('Failed to update Kerberos configuration:', error);
            throw error;
        }
    }

    /**
     * Perform the actual domain provisioning.
     * @param {string} domainName  - FQDN of the new domain (e.g. example.com)
     * @param {string} netbiosName - NetBIOS short name (e.g. EXAMPLE)
     * @param {string} adminPassword - Password for the new Administrator account.
     *   NOTE: samba-tool domain provision requires --adminpass on the command line.
     *   In this privileged Cockpit admin context the brief command-line exposure is acceptable.
     * @param {string} hostname    - FQDN of this DC (e.g. dc1.example.com)
     * @param {string} selectedInterface - Network interface name (e.g. eth0)
     * @param {object} options     - Advanced options collected from the form
     */
    async performDomainProvisioning(domainName, netbiosName, adminPassword, hostname, selectedInterface, options = {}) {
        const realm        = domainName.toUpperCase();
        const dnsBackend   = options.dnsBackend   || 'SAMBA_INTERNAL';
        const dnsForwarder = options.dnsForwarder || '8.8.8.8';
        const siteName     = options.siteName     || '';
        const ntpServers   = options.ntpServers   || null;
        const useRfc2307   = options.useRfc2307   !== false;

        // 1. Set the system hostname
        this.uiManager.showLoading(_('Setting hostname...'));
        await this.setHostname(hostname);

        // 2. Point the interface resolver to localhost so Samba DNS answers domain queries
        this.uiManager.showLoading(_('Configuring DNS resolver...'));
        await this.configureResolverForProvisioning(selectedInterface, domainName, dnsForwarder);

        // 3. Remove stale Samba state to guarantee a clean provision
        this.uiManager.showLoading(_('Clearing previous Samba configuration...'));
        for (const path of ['/etc/samba/smb.conf', '/var/lib/samba/private',
                             '/var/lib/samba/sysvol', '/var/cache/samba']) {
            try {
                await cockpit.spawn(['rm', '-rf', path], { superuser: 'try' });
            } catch (e) { /* best-effort */ }
        }

        // 4. Run samba-tool domain provision
        this.uiManager.showLoading(_('Provisioning domain — this may take up to a minute...'));
        const provisionCmd = [
            'samba-tool', 'domain', 'provision',
            `--realm=${realm}`,
            `--domain=${netbiosName}`,
            '--server-role=dc',
            `--dns-backend=${dnsBackend}`,
            `--adminpass=${adminPassword}`,
        ];
        if (useRfc2307) {
            provisionCmd.push('--use-rfc2307');
        }
        if (dnsForwarder) {
            provisionCmd.push(`--option=dns forwarder = ${dnsForwarder}`);
        }
        if (siteName) {
            provisionCmd.push(`--site=${siteName}`);
        }

        const provisionOutput = await cockpit.spawn(provisionCmd, { superuser: 'try', err: 'out' });
        console.log('samba-tool domain provision output:', provisionOutput);

        // 5. Write Kerberos client configuration
        this.uiManager.showLoading(_('Configuring Kerberos...'));
        await this.updateKerberosConfig(domainName, hostname);

        // 6. Enable and start samba-ad-dc
        this.uiManager.showLoading(_('Starting Samba AD-DC service...'));
        for (const action of ['unmask', 'enable', 'start']) {
            await cockpit.spawn(['systemctl', action, 'samba-ad-dc'], { superuser: 'try' });
        }

        // Allow Samba to fully initialise before configuring dependants
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 7. Configure NTP — this DC is the PDC Emulator and the authoritative time source
        this.uiManager.showLoading(_('Configuring NTP...'));
        try {
            await window.domainController?.serviceManager?.configureNTPForPDC(ntpServers);
        } catch (ntpErr) {
            console.warn('NTP configuration failed (non-fatal):', ntpErr);
        }

        this.uiManager.hideLoading();
        this.uiManager.showSuccess(_('Domain ') + domainName + _(' provisioned successfully!'));

        // Refresh domain status display
        setTimeout(() => window.domainController?.checkDomainStatus?.(), 1000);
    }

    /**
     * Configure systemd-resolved so domain queries resolve via the local Samba DNS.
     * Failures are non-fatal — Samba provision will still work with a manual resolver.
     */
    async configureResolverForProvisioning(iface, domainName, dnsForwarder) {
        try {
            await cockpit.spawn(
                ['resolvectl', 'dns', iface, '127.0.0.1', dnsForwarder || '8.8.8.8'],
                { superuser: 'try' }
            );
            await cockpit.spawn(
                ['resolvectl', 'domain', iface, domainName, `~${domainName}`],
                { superuser: 'try' }
            );
        } catch (error) {
            console.warn('configureResolverForProvisioning: resolvectl failed (non-fatal):', error.message);
        }
    }

    /**
     * Perform the actual domain join as an additional DC.
     * @param {string} domainName         - FQDN of the domain to join
     * @param {string} hostname           - FQDN of this DC
     * @param {string} domainControllerIP - IP of an existing DC
     * @param {string} username           - Domain admin username
     * @param {string} password           - Domain admin password (passed via stdin, not CLI)
     * @param {string} selectedInterface  - Network interface name
     * @param {object} options            - Advanced options collected from the form
     */
    async performDomainJoin(domainName, hostname, domainControllerIP, username, password, selectedInterface, options = {}) {
        const dnsBackend   = options.dnsBackend   || 'SAMBA_INTERNAL';
        const dnsForwarder = options.dnsForwarder || '';
        const siteName     = options.siteName     || '';
        const criticalOnly = options.criticalOnly || false;

        // 1. Point the interface resolver at the existing DC so domain DNS works immediately
        this.uiManager.showLoading(_('Configuring DNS resolver...'));
        await this.configureResolverForJoin(selectedInterface, domainName, domainControllerIP, dnsForwarder);

        // 2. Remove stale Samba state
        this.uiManager.showLoading(_('Clearing previous Samba configuration...'));
        for (const path of ['/etc/samba/smb.conf', '/var/lib/samba/private',
                             '/var/lib/samba/sysvol', '/var/cache/samba']) {
            try {
                await cockpit.spawn(['rm', '-rf', path], { superuser: 'try' });
            } catch (e) { /* best-effort */ }
        }

        // 3. Run samba-tool domain join
        // Password is sent via stdin matching the FSMO operations pattern in this codebase.
        this.uiManager.showLoading(_('Joining domain — this may take several minutes...'));
        const joinCmd = [
            'samba-tool', 'domain', 'join',
            domainName.toUpperCase(),
            'DC',
            '-U', username,
            `--dns-backend=${dnsBackend}`,
            `--server=${domainControllerIP}`,
        ];
        if (dnsForwarder) {
            joinCmd.push(`--option=dns forwarder = ${dnsForwarder}`);
        }
        if (siteName) {
            joinCmd.push(`--site=${siteName}`);
        }
        if (criticalOnly) {
            joinCmd.push('--critical-only');
        }

        const joinProcess = cockpit.spawn(joinCmd, { superuser: 'try', err: 'out' });
        // samba-tool join prompts "Password for [username]:". Send it via stdin.
        joinProcess.input(password + '\n', true);
        const joinOutput = await joinProcess;
        console.log('samba-tool domain join output:', joinOutput);

        // 4. Write Kerberos client configuration
        this.uiManager.showLoading(_('Configuring Kerberos...'));
        await this.updateKerberosConfig(domainName, hostname);

        // 5. Enable and start samba-ad-dc
        this.uiManager.showLoading(_('Starting Samba AD-DC service...'));
        for (const action of ['unmask', 'enable', 'start']) {
            await cockpit.spawn(['systemctl', action, 'samba-ad-dc'], { superuser: 'try' });
        }

        // Allow Samba to fully initialise and begin initial replication
        await new Promise(resolve => setTimeout(resolve, 3000));

        // 6. Configure NTP — sync from the DC we just joined
        this.uiManager.showLoading(_('Configuring NTP...'));
        try {
            await window.domainController?.serviceManager?.configureNTPForAdditionalDC(domainControllerIP, null);
        } catch (ntpErr) {
            console.warn('NTP configuration failed (non-fatal):', ntpErr);
        }

        this.uiManager.hideLoading();
        this.uiManager.showSuccess(_('Successfully joined domain ') + domainName + '!');

        // Refresh domain status display
        setTimeout(() => window.domainController?.checkDomainStatus?.(), 1000);
    }

    /**
     * Configure systemd-resolved so domain queries go to the existing DC.
     * Failures are non-fatal — the user can configure DNS manually.
     */
    async configureResolverForJoin(iface, domainName, dcIP, dnsForwarder) {
        try {
            const servers = dnsForwarder ? [dcIP, dnsForwarder] : [dcIP];
            await cockpit.spawn(
                ['resolvectl', 'dns', iface, ...servers],
                { superuser: 'try' }
            );
            await cockpit.spawn(
                ['resolvectl', 'domain', iface, domainName, `~${domainName}`],
                { superuser: 'try' }
            );
        } catch (error) {
            console.warn('configureResolverForJoin: resolvectl failed (non-fatal):', error.message);
        }
    }
}