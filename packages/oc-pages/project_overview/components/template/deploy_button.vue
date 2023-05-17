<script>
import { mapGetters } from 'vuex'

import { Tooltip as ElTooltip } from 'element-ui'
import { GlButton, GlButtonGroup, GlDropdown, GlDropdownItem } from '@gitlab/ui';
import ErrorSmall from 'oc_vue_shared/components/oc/ErrorSmall.vue'

export default {
    name: 'DeployButton',
    components: {
        ElTooltip,
        ErrorSmall,
        GlButton, GlButtonGroup, GlDropdown, GlDropdownItem
    },
    props: {
        deployStatus: String,
        mergeRequest: Object
    },
    methods: {
        triggerDeploy() {
            if(this.userCanEdit) {
                this.$emit('triggerDeploy')
            } else {
                this.$emit('mergeRequestReady', {status: !this.markedReady})
            }
        },
        triggerLocalDeploy() {
            this.$emit('triggerLocalDeploy')
        }
    },
    computed: {
        ...mapGetters([
            'editingTorndown',
            'cardIsValid',
            'deployTooltip',
            'getPrimaryCard',
            'userCanEdit'
        ]),
        canDeploy() {
            return this.cardIsValid(this.getPrimaryCard)
        },
        workInProgress() {
            return this.mergeRequest && this.mergeRequest.work_in_progress
        },
        markedReady() {
            return this.mergeRequest && !this.workInProgress
        },
        deployButtonText() {
            if(this.userCanEdit) {
                return 'Deploy'
            }
            if(this.markedReady) {
                return 'Mark as Draft'
            }
            return 'Mark as Ready'
        },
        deployButtonIcon() {
            if(this.userCanEdit) {
                return 'upload'
            }
            return 'merge-request-open'
        },
    }
}

</script>
<template>
    <el-tooltip :disabled="!deployTooltip">
        <template #content>
            <div>
                {{deployTooltip}}
            </div>
        </template>
        <div v-if="deployStatus != 'hidden' && !editingTorndown" class="d-flex flex-column position-relative">
            <gl-button-group class="deploy-button">
                <gl-button
                    :aria-label="deployButtonText"
                    data-testid="deploy-button"
                    :title="!deployTooltip? deployButtonText: null"
                    type="button"
                    :icon="deployButtonIcon"
                    class="deploy-action"
                    :disabled="deployStatus == 'disabled' && !markedReady"
                    @click.prevent="triggerDeploy"
                >
                    {{ deployButtonText }}
                </gl-button>
                <gl-dropdown v-if="userCanEdit" :disabled="deployStatus == 'disabled'" right>
                    <gl-dropdown-item @click="triggerLocalDeploy">
                        Deploy Locally
                    </gl-dropdown-item>

                </gl-dropdown>
            </gl-button-group>
            <error-small class="position-absolute" style="top: 2.25em; right: 0; width: 300px; text-align: right;" :condition="!canDeploy">
                <div class="d-flex align-items-center justify-content-end">
                    <span style="line-height: 1;">Deployment is incomplete</span><i style="font-size: 1.25em;" class="el-icon-info ml-1"/>
                </div>
            </error-small>

        </div>
    </el-tooltip>

</template>
<style scoped>
.deploy-button >>> .gl-button {
    margin: 0!important;
    padding: 8px 12px !important;
}
.deploy-button >>> svg {
    margin-left: 0!important;
}
</style>